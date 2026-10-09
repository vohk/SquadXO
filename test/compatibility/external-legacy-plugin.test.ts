import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLegacyPluginPlan } from '../../src/compatibility/legacy-plugin-plan.js';
import { LegacyPluginLoader } from '../../src/compatibility/legacy-plugin-loader.js';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import {
  loadRuntimeConfig,
  type RuntimeLegacyPluginConfig
} from '../../src/config/runtime-config.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import { SquadRconClient } from '../../src/rcon/client.js';

const server = {
  id: 1,
  host: '127.0.0.1',
  rconPort: 1,
  rconPassword: 'unused',
  logReaderMode: 'tail',
  logDir: '/tmp'
};

test('configuration loads an external minified legacy fixture and owns its lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-external-legacy-'));
  const configPath = join(directory, 'config.json');
  const calls: string[] = [];
  const globals = globalThis as Record<string, unknown>;
  globals.__externalLegacyCalls = calls;
  const rcon = new SquadRconClient({
    host: '127.0.0.1',
    port: 1,
    password: 'unused',
    autoReconnect: false
  });
  const events = new LegacyServerHost({ state: new ServerState(), rcon });
  const loader = new LegacyPluginLoader({ host: events, connectors: new ConnectorRegistry({}) });
  try {
    await writeFile(
      join(directory, 'fixture.mjs'),
      `const p=class ExternalFixture{constructor(){globalThis.__externalLegacyCalls.push('create')}mount(){globalThis.__externalLegacyCalls.push('mount')}unmount(){globalThis.__externalLegacyCalls.push('unmount')}};export default p;`
    );
    await writeFile(
      configPath,
      JSON.stringify({
        server,
        plugins: [{ plugin: 'ExternalFixture', module: './fixture.mjs', enabled: true }]
      })
    );
    const config = await loadRuntimeConfig(configPath);
    const entries = config.plugins as RuntimeLegacyPluginConfig[];
    assert.equal(entries[0]?.modulePath, join(directory, 'fixture.mjs'));
    const plan = await createLegacyPluginPlan(entries, join(directory, 'absent-builtins'));
    assert.deepEqual(calls, []);
    await loader.mountAll(
      plan.plugins.map(({ PluginClass, config }) => ({ PluginClass, rawOptions: config }))
    );
    assert.deepEqual(calls, ['create', 'mount']);
    await loader.stop();
    assert.deepEqual(calls, ['create', 'mount', 'unmount']);
    assert.equal(events.plugins.length, 0);

    await assert.rejects(
      createLegacyPluginPlan([{ ...entries[0]!, plugin: 'WrongName' }]),
      /default class/
    );
    const { modulePath: _modulePath, ...unresolved } = entries[0]!;
    await assert.rejects(createLegacyPluginPlan([unresolved]), /has not been resolved/);
    await writeFile(join(directory, 'invalid.mjs'), 'export default {};');
    await assert.rejects(
      createLegacyPluginPlan([{ ...entries[0]!, modulePath: join(directory, 'invalid.mjs') }]),
      /default class/
    );
    await writeFile(
      configPath,
      JSON.stringify({
        server,
        plugins: [{ plugin: 'ExternalFixture', module: 42, enabled: true }]
      })
    );
    await assert.rejects(loadRuntimeConfig(configPath), /config.plugins\[0\].module/);
  } finally {
    await loader.stop();
    delete globals.__externalLegacyCalls;
    await rm(directory, { recursive: true, force: true });
  }
});

test('disabled external modules are not imported; connectors are validated before mount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-external-plan-'));
  try {
    assert.deepEqual(
      (await createLegacyPluginPlan([{ plugin: 'Disabled', module: 'missing', enabled: false }]))
        .plugins,
      []
    );
    const modulePath = join(directory, 'connector.mjs');
    await writeFile(
      modulePath,
      `export default class ConnectorFixture { static optionsSpecification = { database: { connector: 'sequelize', required: true } }; constructor() { throw new Error('must not construct during planning'); } }`
    );
    const config: RuntimeLegacyPluginConfig = {
      plugin: 'ConnectorFixture',
      module: './connector.mjs',
      modulePath,
      enabled: true
    };
    await assert.rejects(createLegacyPluginPlan([config]), /database.*missing/);
    const plan = await createLegacyPluginPlan([{ ...config, database: 'primary' }]);
    assert.deepEqual(plan.connectors, [
      { name: 'primary', type: 'sequelize', plugin: 'ConnectorFixture' }
    ]);
    await assert.rejects(
      createLegacyPluginPlan([{ ...config, plugin: 'DBLog' }]),
      /TypeScript core/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('name-only minified loading uses filenames and skips unrelated modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-private-bundle-'));
  try {
    await writeFile(join(directory, 'chat.js'), 'export default class ChatCommands {}');
    await writeFile(join(directory, 'package.json'), '{ "type": "module" }');
    await writeFile(
      join(directory, 'squadjs-bundled-fixture.build.min.js'),
      'throw new Error("must not import unrequested private modules");'
    );
    const publicPlan = await createLegacyPluginPlan(
      [{ plugin: 'ChatCommands', enabled: true }],
      directory
    );
    assert.equal(publicPlan.plugins[0]?.name, 'ChatCommands');
    await writeFile(
      join(directory, 'squadjs-bundled-fixture.build.min.js'),
      'const Fixture = class BundledFixture {}; export default Fixture;'
    );
    const privatePlan = await createLegacyPluginPlan(
      [{ plugin: 'BundledFixture', enabled: true }],
      directory
    );
    assert.equal(privatePlan.plugins[0]?.name, 'BundledFixture');
    assert.equal(
      privatePlan.plugins[0]?.path,
      join(directory, 'squadjs-bundled-fixture.build.min.js')
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
