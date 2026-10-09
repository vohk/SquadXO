import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyPluginPlan } from '../../src/compatibility/legacy-plugin-plan.js';

test('plans enabled public source plugins and their connectors', async () => {
  const plan = await createLegacyPluginPlan([
    { plugin: 'ChatCommands', enabled: true, commands: [] },
    {
      plugin: 'unnAdminRequest',
      enabled: true,
      discordClient: 'discord',
      channelID: '123'
    },
    { plugin: 'DBLog', enabled: true, database: 'postgres' },
    { plugin: 'PlayerStateTracker', enabled: true },
    { plugin: 'AutoTKWarn', enabled: false }
  ]);

  assert.deepEqual(
    plan.plugins.map((plugin) => plugin.name),
    ['ChatCommands', 'unnAdminRequest', 'PlayerStateTracker']
  );
  assert.deepEqual(plan.connectors, [
    { name: 'discord', type: 'discord', plugin: 'unnAdminRequest' },
    { name: 'postgres', type: 'sequelize', plugin: 'DBLog' }
  ]);
  assert.deepEqual(plan.skipped, {
    DBLog: 'handled by the TypeScript core'
  });
});

test('rejects missing connector selections and unknown enabled plugins', async () => {
  await assert.rejects(
    createLegacyPluginPlan([{ plugin: 'unnAdminRequest', enabled: true }]),
    /discordClient \(discord connector\) is missing/
  );
  await assert.rejects(
    createLegacyPluginPlan([{ plugin: 'DoesNotExist', enabled: true }]),
    /Enabled plugin does not exist/
  );
});

test('shares a named primary connector while allowing plugin-local SQLite state', async () => {
  const plan = await createLegacyPluginPlan([
    { plugin: 'DBLog', enabled: true, database: 'primary' },
    {
      plugin: 'SmartSwitch',
      enabled: true,
      database: 'primary',
      discordClient: 'discord'
    },
    {
      plugin: 'PlayerStateTracker',
      enabled: true,
      database: 'tracker-state'
    }
  ]);

  assert.deepEqual(
    plan.plugins.map((plugin) => plugin.name),
    ['SmartSwitch', 'PlayerStateTracker']
  );
  assert.deepEqual(
    plan.connectors.map(({ name, type }) => ({ name, type })),
    [
      { name: 'primary', type: 'sequelize' },
      { name: 'discord', type: 'discord' },
      { name: 'tracker-state', type: 'sequelize' }
    ]
  );
});

test('plans PlayerStateTracker with an explicit database and no DBLog dependency', async () => {
  const plan = await createLegacyPluginPlan([
    { plugin: 'PlayerStateTracker', enabled: true, database: 'tracker-state' }
  ]);

  assert.deepEqual(plan.connectors, [
    { name: 'tracker-state', type: 'sequelize', plugin: 'PlayerStateTracker' }
  ]);
  assert.deepEqual(
    plan.plugins.map((plugin) => plugin.name),
    ['PlayerStateTracker']
  );
});
