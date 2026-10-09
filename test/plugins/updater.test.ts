import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import type { RuntimeManagedNativePluginConfig } from '../../src/config/runtime-config.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import { createNativePluginPlan, mountNativePlugin } from '../../src/plugins/loader.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { NativePluginUpdater } from '../../src/plugins/updater.js';
import { SquadRconClient } from '../../src/rcon/client.js';

class FakeRcon extends SquadRconClient {
  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }
}

test('downloads and reuses an immutable managed native revision', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-plugin-updater-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = githubRemote(pluginSource('v1'));
  const config = managedConfig(directory);
  const updater = new NativePluginUpdater({ fetch: remote.fetch });

  const [resolved] = await updater.resolve([config]);
  assert.ok(resolved?.modulePath.includes(remote.revision));
  assert.equal(remote.requests.length, 1);
  assert.match(await readFile(resolved!.modulePath, 'utf8'), /v1/);
  await updater.markStartupHealthy();

  const [cached] = await updater.resolve([config]);
  assert.equal(cached?.modulePath, resolved?.modulePath);
  assert.equal(remote.requests.length, 1);
  assert.equal(updater.health().Managed?.activeRevision, remote.revision);
});

test('hot reloads a validated native plugin and rolls back a failed candidate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-plugin-hot-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = githubRemote(pluginSource('v1'));
  const config = managedConfig(directory);
  const updater = new NativePluginUpdater({ fetch: remote.fetch });
  const [resolved] = await updater.resolve([config]);
  const plan = await createNativePluginPlan([resolved!]);
  const state = new ServerState();
  const rcon = new FakeRcon();
  const events = new LegacyServerHost({ state, rcon });
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry()
  });
  await mountNativePlugin(runtime, plan.plugins[0]!);
  updater.bind(runtime, plan);
  await updater.markStartupHealthy();

  events.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 50 } });
  await events.drain();
  assert.deepEqual(updaterEvents(), ['v1']);

  remote.set(pluginSource('v2'));
  await updater.checkNow('Managed');
  events.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 49 } });
  await events.drain();
  assert.deepEqual(updaterEvents(), ['v1', 'unmount-v1', 'v2']);
  assert.equal(updater.health().Managed?.activeRevision, remote.revision);

  remote.set(pluginSource('broken', true));
  await assert.rejects(updater.checkNow('Managed'), /rollback succeeded/);
  events.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 48 } });
  await events.drain();
  assert.deepEqual(updaterEvents(), [
    'v1',
    'unmount-v1',
    'v2',
    'unmount-v2',
    'broken',
    'unmount-broken',
    'v2'
  ]);
  assert.match(updater.health().Managed?.lastError ?? '', /rollback succeeded/);

  await updater.stop();
  await runtime.stop();
  delete (globalThis as Record<string, unknown>).__managedUpdaterEvents;
});

test('stages restart updates and promotes them only after healthy startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-plugin-restart-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = githubRemote(pluginSource('v1'));
  const config = managedConfig(directory, 'restart');
  const first = new NativePluginUpdater({ fetch: remote.fetch });
  const [initial] = await first.resolve([config]);
  const plan = await createNativePluginPlan([initial!]);
  const state = new ServerState();
  const rcon = new FakeRcon();
  const events = new LegacyServerHost({ state, rcon });
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry()
  });
  await mountNativePlugin(runtime, plan.plugins[0]!);
  first.bind(runtime, plan);
  await first.markStartupHealthy();

  remote.set(pluginSource('v2'));
  await first.checkNow('Managed');
  assert.equal(first.health().Managed?.activeRevision, gitBlobSha(pluginSource('v1')));
  assert.equal(first.health().Managed?.stagedRevision, remote.revision);
  await first.stop();
  await runtime.stop();

  const second = new NativePluginUpdater({ fetch: remote.fetch });
  const [trial] = await second.resolve([config]);
  assert.ok(trial?.modulePath.includes(remote.revision));
  await second.markStartupHealthy();
  assert.equal(second.health().Managed?.activeRevision, remote.revision);
  assert.equal(second.health().Managed?.stagedRevision, undefined);
  await second.stop();
  delete (globalThis as Record<string, unknown>).__managedUpdaterEvents;
});

function managedConfig(
  storagePath: string,
  apply: 'hot' | 'restart' = 'hot'
): RuntimeManagedNativePluginConfig {
  return {
    type: 'native',
    name: 'Managed',
    source: {
      provider: 'github',
      repository: 'example/managed-plugin',
      ref: 'main',
      path: 'dist/plugin.js'
    },
    updates: { enabled: true, intervalMinutes: 240, apply },
    storagePath,
    enabled: true,
    options: {},
    connectors: {}
  };
}

function pluginSource(label: string, failMount = false): string {
  return `export default {
  apiVersion: 1,
  name: 'Managed',
  options: {},
  connectors: {},
  create() {
    return {
      mount(context) {
        const events = globalThis.__managedUpdaterEvents ??= [];
        ${failMount ? `events.push('${label}'); throw new Error('candidate mount failed');` : ''}
        context.on('TICK_RATE', () => events.push('${label}'));
      },
      unmount() { globalThis.__managedUpdaterEvents.push('unmount-${label}'); }
    };
  }
};\n`;
}

function updaterEvents(): string[] {
  return ((globalThis as Record<string, unknown>).__managedUpdaterEvents ?? []) as string[];
}

function githubRemote(initialSource: string) {
  let source = initialSource;
  const requests: string[] = [];
  return {
    requests,
    get revision() {
      return gitBlobSha(source);
    },
    set(next: string) {
      source = next;
    },
    fetch: async (input: string | URL | Request): Promise<Response> => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          type: 'file',
          sha: gitBlobSha(source),
          encoding: 'base64',
          content: Buffer.from(source).toString('base64')
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  };
}

function gitBlobSha(source: string): string {
  const contents = Buffer.from(source);
  return createHash('sha1')
    .update(Buffer.from(`blob ${contents.length}\0`))
    .update(contents)
    .digest('hex');
}
