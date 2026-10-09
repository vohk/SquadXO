import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import type { NativePluginDefinition } from '../../src/plugins/api.js';

interface MetadataEntry {
  module: string;
  definition: NativePluginDefinition;
}
interface GeneratedNativeConfig {
  module?: string;
  source?: unknown;
  enabled: boolean;
  options: Record<string, unknown>;
  connectors: Record<string, string>;
}
interface MetadataOverrides {
  native: MetadataEntry[];
  legacy: Record<string, never>;
  template?: { plugins: unknown[] };
}
import { pathToFileURL } from 'node:url';

const generator = (await import(
  pathToFileURL(resolve('squad-server/scripts/plugin-metadata.js')).href
)) as {
  buildReadme(): Promise<string>;
  buildReference(overrides?: MetadataOverrides): Promise<string>;
  readNativePlugins(sources: string[], outputRoot: string): Promise<MetadataEntry[]>;
  nativeConfig(entry: MetadataEntry, configured?: Record<string, unknown>): GeneratedNativeConfig;
  buildConfig(overrides?: MetadataOverrides): Promise<{ plugins: GeneratedNativeConfig[] }>;
};

test('generated config, README and reference match the committed artifacts', async () => {
  const committedConfig = await readFile(resolve('config.example.json'), 'utf8');
  const generatedConfig = `${JSON.stringify(await generator.buildConfig(), null, 2)}\n`;
  assert.equal(generatedConfig, committedConfig);

  const committedReadme = await readFile(resolve('README.md'), 'utf8');
  assert.equal(await generator.buildReadme(), committedReadme);
  const reference = await readFile(resolve('docs/reference/plugins.md'), 'utf8');
  assert.equal(await generator.buildReference(), reference);
});

test('native metadata generates defaults without creating plugins and preserves managed sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squadxo-metadata-'));
  try {
    await mkdir(join(root, 'src/plugins/builtin'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(root, 'src/plugins/builtin/fixture.js'),
      `
      export default {
        apiVersion: 1, name: 'Fixture', description: 'Fixture description.',
        options: {
          channel: {type: 'string', required: true, description: 'Target channel.'},
          limit: {type: 'number', default: 4, description: 'Limit.'},
          apiToken: {type: 'string', default: 'restricted-fixture-token', description: 'Token.'}
        },
        connectors: {
          discord: {type: 'discord', description: 'Bot.'},
          database: {type: 'sequelize', required: false, description: 'Optional database.'}
        },
        create() { throw new Error('Metadata generation must not create a plugin'); }
      };
    `
    );
    const native = await generator.readNativePlugins(['src/plugins/builtin/fixture.ts'], root);
    assert.equal(native.length, 1);
    const entry = native[0]!;
    const generated = await generator.buildConfig({
      native,
      legacy: {},
      template: { plugins: [] }
    });
    const config = generated.plugins[0]!;
    assert.equal(config.enabled, false);
    assert.equal(config.module, './dist/src/plugins/builtin/fixture.js');
    assert.deepEqual(config.options, { channel: '', limit: 4, apiToken: '' });
    assert.deepEqual(config.connectors, { discord: 'discord' });
    const source = {
      provider: 'github',
      repository: 'example/plugins',
      ref: 'v1',
      path: 'fixture.js'
    };
    const managed = generator.nativeConfig(entry, {
      source,
      enabled: true,
      options: { limit: 9 },
      connectors: { discord: 'operations' }
    });
    assert.equal(managed.module, undefined);
    assert.deepEqual(managed.source, source);
    assert.equal(managed.enabled, true);
    assert.equal(managed.options.limit, 9);
    assert.equal(managed.connectors.discord, 'operations');
    assert.throws(
      () => generator.nativeConfig(entry, { options: { unknown: 1 } }),
      /unknown template option/
    );
    assert.throws(
      () => generator.nativeConfig(entry, { connectors: { unknown: 'bot' } }),
      /unknown template connector/
    );
    const reference = await generator.buildReference({ native, legacy: {} });
    assert.ok(reference.includes('### Fixture'));
    assert.ok(reference.includes('Fixture description.'));
    assert.ok(reference.includes('`[redacted]`'));
    assert.ok(!reference.includes('restricted-fixture-token'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('README, migration and plugin reference link to existing local files', async () => {
  for (const file of ['README.md', 'docs/deployment/migration.md', 'docs/reference/plugins.md']) {
    const contents = await readFile(resolve(file), 'utf8');
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^(https?:|#)/.test(target)) continue;
      await access(resolve(dirname(file), target.split('#')[0]!));
    }
  }
});
