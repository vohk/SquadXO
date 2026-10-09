import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { LegacyPluginLoader } from '../../src/compatibility/legacy-plugin-loader.js';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import {
  loadRuntimeConfig,
  type RuntimeNativePluginConfig
} from '../../src/config/runtime-config.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { asEOSID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import { createNativePluginPlan, mountNativePlugin } from '../../src/plugins/loader.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';

const eosID = asEOSID('11111111111111111111111111111111');

class FakeRcon extends SquadRconClient {
  readonly warnings: string[] = [];

  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }

  override async warn(_eosID: typeof eosID, message: string): Promise<void> {
    this.warnings.push(message);
  }
}

test('configuration selects an external native plugin alongside a legacy plugin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-native-coexistence-'));
  try {
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'unused',
          logReaderMode: 'tail',
          logDir: directory
        },
        connectors: { primary: 'sqlite::memory:' },
        plugins: [
          {
            type: 'native',
            name: 'NativeAdminPing',
            module: resolve('examples/native-admin-ping.mjs'),
            enabled: true,
            options: { response: 'Native response' },
            connectors: { database: 'primary' }
          },
          { plugin: 'ChatCommands', enabled: true, commands: [] }
        ]
      })
    );
    const config = await loadRuntimeConfig(configPath);
    const nativeConfigs = config.plugins.filter(
      (plugin): plugin is RuntimeNativePluginConfig => plugin.type === 'native'
    );
    const plan = await createNativePluginPlan(nativeConfigs);
    const state = new ServerState();
    const player = state.upsertPlayer({ eosID, name: 'Alpha' });
    const rcon = new FakeRcon();
    const events = new LegacyServerHost({ state, rcon });
    const connectors = new ConnectorRegistry({ primary: { dialect: 'sqlite' } });
    const nativeRuntime = new PluginRuntime({ state, rcon, events, connectors });
    const legacyLoader = new LegacyPluginLoader({ host: events, connectors });

    await legacyLoader.load(resolve('squad-server/plugins/chat-commands.js'), { commands: [] });
    await mountNativePlugin(nativeRuntime, plan.plugins[0]!);
    events.publish({
      name: 'CHAT_MESSAGE',
      data: { chat: 'ChatAll', message: '!nativeping', player }
    });
    await events.drain();

    assert.deepEqual(rcon.warnings, ['Native response']);
    assert.equal(events.plugins.length, 1);
    await nativeRuntime.stop();
    await legacyLoader.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
