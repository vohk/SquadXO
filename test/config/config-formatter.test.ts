import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatConfigFile, formatConfigSource } from '../../src/config/config-formatter.js';

test('orders top-level sections, connectors, plugins, and identifying plugin fields', () => {
  const formatted = formatConfigSource(
    JSON.stringify({
      extension: { keep: true },
      plugins: [
        { customFirst: 1, enabled: false, plugin: 'zulu', customSecond: 2 },
        {
          options: { greeting: 'hello' },
          enabled: true,
          module: './alpha.mjs',
          name: 'Alpha',
          type: 'native',
          connectors: {}
        },
        { enabled: true, plugin: 'bravo', command: '!b' }
      ],
      layers: {
        extension: true,
        sources: [{ url: 'https://example.com/layers.json', extension: true, name: 'Example' }]
      },
      connectors: { zeta: 'sqlite:zeta.sqlite', alpha: 'sqlite:alpha.sqlite' },
      server: { adminLists: [], rconPort: 21114, id: 1, host: '127.0.0.1' },
      configManagement: { sortPlugins: true, reorderOnStartup: true }
    })
  );
  const parsed = JSON.parse(formatted) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    'server',
    'layers',
    'connectors',
    'plugins',
    'configManagement',
    'extension'
  ]);
  assert.deepEqual(Object.keys(parsed.server as object), ['id', 'host', 'rconPort', 'adminLists']);
  assert.deepEqual(Object.keys(parsed.layers as object), ['sources', 'extension']);
  assert.deepEqual(Object.keys((parsed.layers as { sources: object[] }).sources[0] ?? {}), [
    'name',
    'url',
    'extension'
  ]);
  assert.deepEqual(Object.keys(parsed.connectors as object), ['alpha', 'zeta']);
  const plugins = parsed.plugins as Record<string, unknown>[];
  assert.deepEqual(
    plugins.map((plugin) => plugin.name ?? plugin.plugin),
    ['Alpha', 'bravo', 'zulu']
  );
  assert.deepEqual(Object.keys(plugins[0] ?? {}), [
    'type',
    'name',
    'module',
    'enabled',
    'connectors',
    'options'
  ]);
  assert.deepEqual(Object.keys(plugins[2] ?? {}), [
    'plugin',
    'enabled',
    'customFirst',
    'customSecond'
  ]);
  assert.deepEqual(Object.keys(parsed.configManagement as object), [
    'reorderOnStartup',
    'sortPlugins'
  ]);
  assert.ok(formatted.endsWith('\n'));
});

test('can preserve plugin array order while still ordering plugin identity fields', () => {
  const formatted = formatConfigSource(
    JSON.stringify({
      server: {},
      connectors: {},
      plugins: [
        { enabled: true, plugin: 'Zulu', value: 1 },
        { value: 2, plugin: 'Alpha', enabled: false }
      ]
    }),
    { sortPlugins: false }
  );
  const plugins = (JSON.parse(formatted) as { plugins: Record<string, unknown>[] }).plugins;
  assert.deepEqual(
    plugins.map((plugin) => plugin.plugin),
    ['Zulu', 'Alpha']
  );
  assert.deepEqual(Object.keys(plugins[1] ?? {}), ['plugin', 'enabled', 'value']);
});

test('preserves unknown legacy sections without treating them as runtime sections', () => {
  const formatted = formatConfigSource(
    JSON.stringify({
      logger: { colors: { Plugin: 36 }, verboseness: { Plugin: 1 } },
      plugins: [],
      server: {}
    })
  );

  const parsed = JSON.parse(formatted);
  assert.deepEqual(Object.keys(parsed), ['server', 'plugins', 'logger']);
  assert.deepEqual(parsed.logger, {
    colors: { Plugin: 36 },
    verboseness: { Plugin: 1 }
  });
});

test('orders managed native source and update policy before plugin options', () => {
  const formatted = formatConfigSource(
    JSON.stringify({
      plugins: [
        {
          options: {},
          updates: { apply: 'hot', enabled: true },
          enabled: true,
          source: {
            provider: 'github',
            repository: 'example/plugin',
            path: 'dist/plugin.js'
          },
          name: 'Managed',
          type: 'native',
          connectors: {}
        }
      ]
    })
  );
  const plugin = (JSON.parse(formatted) as { plugins: Record<string, unknown>[] }).plugins[0];
  assert.deepEqual(Object.keys(plugin ?? {}), [
    'type',
    'name',
    'source',
    'updates',
    'enabled',
    'connectors',
    'options'
  ]);
});

test('atomically formats a regular file, preserves its mode, and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-format-config-'));
  const path = join(directory, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ plugins: [], connectors: {}, server: {} }));
    await chmod(path, 0o640);
    assert.equal((await formatConfigFile(path)).changed, true);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))), [
      'server',
      'connectors',
      'plugins'
    ]);
    assert.equal((await formatConfigFile(path)).changed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not replace the source file when parsing fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-format-config-invalid-'));
  const path = join(directory, 'config.json');
  const source = '{ invalid';
  try {
    await writeFile(path, source);
    await assert.rejects(formatConfigFile(path), /config: invalid JSON/);
    assert.equal(await readFile(path, 'utf8'), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
