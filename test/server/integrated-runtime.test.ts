import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeConfig } from '../../src/config/runtime-config.js';
import { IntegratedRuntime } from '../../src/server/integrated-runtime.js';

test('native plugin preflight fails before opening RCON', async () => {
  const config: RuntimeConfig = {
    server: {
      id: 1,
      host: '127.0.0.1',
      rconPort: 1,
      rconPassword: 'unused',
      logReaderMode: 'tail',
      logDir: '/tmp'
    },
    connectors: {},
    plugins: [
      {
        type: 'native',
        name: 'MissingPlugin',
        module: './does-not-exist.mjs',
        modulePath: '/tmp/does-not-exist.mjs',
        enabled: true,
        options: {},
        connectors: {}
      }
    ],
    configManagement: { reorderOnStartup: false, sortPlugins: true }
  };
  const runtime = new IntegratedRuntime(config);

  await assert.rejects(runtime.start(), /MissingPlugin failed during import/);
  assert.equal(runtime.health().rconState, 'disconnected');
  assert.equal(runtime.health().dbWriteHighWaterMark, 0);
  assert.equal(runtime.health().dbRejectedWrites, 0);
  assert.equal(runtime.health().dbPlayerUpserts, 0);
  assert.equal(runtime.health().dbPlayerUpsertSkips, 0);
});

test('logs one RCON loss and one authenticated recovery without logging retry states', () => {
  const messages: Array<{ level: string; scope: string; message: string }> = [];
  const config: RuntimeConfig = {
    server: {
      id: 6,
      host: '127.0.0.1',
      rconPort: 21114,
      rconPassword: 'unused',
      logReaderMode: 'tail',
      logDir: '/tmp'
    },
    connectors: {},
    plugins: [],
    configManagement: { reorderOnStartup: false, sortPlugins: true }
  };
  const runtime = new IntegratedRuntime(config, {
    loadPlugins: false,
    lifecycleLogger: (level, scope, message) => messages.push({ level, scope, message })
  });

  runtime.rcon.emit('state', 'connecting');
  runtime.rcon.emit('socketError', new Error('ECONNREFUSED'));
  runtime.rcon.emit('state', 'disconnected');
  assert.deepEqual(messages, []);

  runtime.rcon.emit('connectionLost', {
    error: new Error('RCON connection closed'),
    disconnectedAt: new Date('2026-08-23T00:00:00.000Z'),
    willReconnect: true
  });
  runtime.rcon.emit('reconnected', {
    disconnectedAt: new Date('2026-08-23T00:00:00.000Z'),
    reconnectedAt: new Date('2026-08-23T00:01:05.000Z'),
    durationMs: 65_000,
    attempts: 4
  });

  assert.deepEqual(messages, [
    {
      level: 'error',
      scope: 'RCON',
      message:
        'Connection to 127.0.0.1:21114 lost (RCON connection closed); reconnecting in the background.'
    },
    {
      level: 'info',
      scope: 'RCON',
      message: 'Reconnected to 127.0.0.1:21114 after 1m 5s (4 attempts).'
    }
  ]);
});

test('logs legacy callback failures with plugin and event context', async () => {
  const messages: Array<{ level: string; scope: string; message: string }> = [];
  const config: RuntimeConfig = {
    server: {
      id: 1,
      host: '127.0.0.1',
      rconPort: 1,
      rconPassword: 'unused',
      logReaderMode: 'tail',
      logDir: '/tmp'
    },
    connectors: {},
    plugins: [],
    configManagement: { reorderOnStartup: false, sortPlugins: true }
  };
  const runtime = new IntegratedRuntime(config, {
    loadPlugins: false,
    lifecycleLogger: (level, scope, message) => messages.push({ level, scope, message })
  });
  const facade = runtime.events.createFacade('BrokenLegacy');
  facade.on('TICK_RATE', async () => {
    throw new Error('simulated callback failure');
  });

  runtime.events.publish({ name: 'TICK_RATE', data: { tickRate: 40, time: new Date() } });
  await runtime.events.drain();

  assert.equal(runtime.health().pluginErrorCount, 1);
  assert.deepEqual(messages, [
    {
      level: 'error',
      scope: 'Plugin:BrokenLegacy',
      message: 'Callback failed while handling TICK_RATE: simulated callback failure'
    }
  ]);
  facade.dispose();
});
