import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadRuntimeConfig } from '../../src/config/runtime-config.js';

test('validates current config shape with path-specific errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-config-'));
  const path = join(directory, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ server: { id: 1 }, plugins: [] }));
    await assert.rejects(loadRuntimeConfig(path), /config.server.logReaderMode/);

    await writeFile(
      path,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'test',
          queryPort: 27165,
          logReaderMode: 'tail',
          logDir: '/tmp'
        },
        connectors: {},
        plugins: [{ plugin: 'ChatCommands', enabled: false, unknownField: 'preserved' }]
      })
    );
    const config = await loadRuntimeConfig(path);
    assert.equal(config.server.logReaderMode, 'tail');
    assert.equal(config.server.queryPort, 27165);
    assert.equal(config.plugins[0]?.unknownField, 'preserved');
    assert.deepEqual(config.configManagement, {
      reorderOnStartup: false,
      sortPlugins: true
    });

    await writeFile(
      path,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'test',
          logReaderMode: 'tail',
          logDir: '/tmp'
        },
        plugins: [],
        configManagement: { reorderOnStartup: true, sortPlugins: false }
      })
    );
    const managedConfig = await loadRuntimeConfig(path);
    assert.deepEqual(managedConfig.configManagement, {
      reorderOnStartup: true,
      sortPlugins: false
    });

    await writeFile(
      path,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'test',
          logReaderMode: 'tail',
          logDir: '/tmp'
        },
        plugins: [],
        configManagement: { reorderOnStartup: 'yes' }
      })
    );
    await assert.rejects(
      loadRuntimeConfig(path),
      /config\.configManagement\.reorderOnStartup: expected a boolean/
    );

    await writeFile(
      path,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'test',
          logReaderMode: 'tail',
          logDir: '/tmp'
        },
        plugins: [
          {
            type: 'native',
            name: 'Example',
            module: './example.mjs',
            enabled: true,
            options: { greeting: 'hello' },
            connectors: { database: 'sqlite' }
          }
        ]
      })
    );
    const nativeConfig = await loadRuntimeConfig(path);
    assert.deepEqual(nativeConfig.plugins[0], {
      type: 'native',
      name: 'Example',
      module: './example.mjs',
      modulePath: join(directory, 'example.mjs'),
      enabled: true,
      options: { greeting: 'hello' },
      connectors: { database: 'sqlite' }
    });

    await writeFile(
      path,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'test',
          logReaderMode: 'tail',
          logDir: '/tmp'
        },
        plugins: [
          {
            type: 'native',
            name: 'ManagedExample',
            source: {
              provider: 'github',
              repository: 'example/squadjs-plugin',
              path: 'dist/plugin.js'
            },
            updates: { enabled: true },
            enabled: true,
            options: {},
            connectors: {}
          }
        ]
      })
    );
    const managedNativeConfig = await loadRuntimeConfig(path);
    assert.deepEqual(managedNativeConfig.plugins[0], {
      type: 'native',
      name: 'ManagedExample',
      source: {
        provider: 'github',
        repository: 'example/squadjs-plugin',
        ref: 'main',
        path: 'dist/plugin.js'
      },
      updates: { enabled: true, intervalMinutes: 240, apply: 'hot' },
      storagePath: resolve('data/native-plugins/ManagedExample'),
      enabled: true,
      options: {},
      connectors: {}
    });

    await writeFile(
      path,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'test',
          logReaderMode: 'tail',
          logDir: '/tmp'
        },
        plugins: [
          {
            type: 'native',
            name: 'BadManaged',
            module: './plugin.mjs',
            source: {
              provider: 'github',
              repository: 'example/plugin',
              path: 'plugin.js'
            },
            enabled: true
          }
        ]
      })
    );
    await assert.rejects(loadRuntimeConfig(path), /module and source cannot both be configured/);

    await writeFile(
      path,
      JSON.stringify({
        server: {
          id: 1,
          host: '127.0.0.1',
          rconPort: 21114,
          rconPassword: 'test',
          logReaderMode: 'tail',
          logDir: '/tmp'
        },
        plugins: [{ type: 'native', name: 'Bad', enabled: true }]
      })
    );
    await assert.rejects(loadRuntimeConfig(path), /config\.plugins\[0]\.module/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validates optional layer catalog sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-layer-config-'));
  const path = join(directory, 'config.json');
  const base = {
    server: {
      id: 1,
      host: '127.0.0.1',
      rconPort: 21114,
      rconPassword: 'test',
      logReaderMode: 'tail',
      logDir: '/tmp'
    },
    plugins: []
  };
  try {
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        layers: {
          sources: [
            { name: 'Squad', url: 'https://example.com/squad.json' },
            { name: 'Example Mod', url: 'https://example.com/mod.json' }
          ]
        }
      })
    );
    const config = await loadRuntimeConfig(path);
    assert.deepEqual(config.layers, {
      sources: [
        { name: 'Squad', url: 'https://example.com/squad.json' },
        { name: 'Example Mod', url: 'https://example.com/mod.json' }
      ]
    });

    await writeFile(
      path,
      JSON.stringify({
        ...base,
        layers: { sources: [{ name: 'Squad', url: 'http://example.com/layers.json' }] }
      })
    );
    await assert.rejects(
      loadRuntimeConfig(path),
      /config\.layers\.sources\[0\]\.url: expected a valid HTTPS URL/
    );

    await writeFile(
      path,
      JSON.stringify({
        ...base,
        layers: {
          sources: [
            { name: 'Squad', url: 'https://example.com/one.json' },
            { name: 'squad', url: 'https://example.com/two.json' }
          ]
        }
      })
    );
    await assert.rejects(
      loadRuntimeConfig(path),
      /config\.layers\.sources\[1\]\.name: duplicate layer source name/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
