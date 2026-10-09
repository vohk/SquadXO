import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { QueryTypes, Sequelize } from 'sequelize';
import { createLegacyPluginPlan } from '../../src/compatibility/legacy-plugin-plan.js';
import { loadRuntimeConfig } from '../../src/config/runtime-config.js';
import { LegacyConnectorManager } from '../../src/connectors/legacy-connector-manager.js';
import { DbLog } from '../../src/database/db-log.js';
import { asEOSID, asSteamID } from '../../src/domain/identity.js';

test('generated SQLite selection shares one durable connector without enabling optional plugins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squadxo-sqlite-default-'));
  const manager = new LegacyConnectorManager();
  try {
    const example = JSON.parse(await readFile(resolve('config.example.json'), 'utf8'));
    assert.equal(example.connectors.sqlite, 'sqlite:database.sqlite');
    for (const [name, option, enabled] of [
      ['DBLog', 'database', false],
      ['SmartSwitch', 'database', true],
      ['PlayerStateTracker', 'database', false],
      ['DiscordServerStatus', 'messageStore', true]
    ] as const) {
      const plugin = example.plugins.find((entry: { plugin?: string }) => entry.plugin === name);
      assert.equal(plugin[option], 'sqlite');
      assert.equal(plugin.enabled, enabled);
    }
    example.server.host = '127.0.0.1';
    example.server.rconPassword = 'fixture-only';
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(example));
    const config = await loadRuntimeConfig(configPath);
    const plan = await createLegacyPluginPlan(
      config.plugins.filter((entry) => entry.type !== 'native')
    );
    const requirements = plan.connectors.filter((entry) => entry.type === 'sequelize');
    assert.deepEqual(
      requirements.map((entry) => entry.name),
      ['sqlite']
    );
    const storage = join(root, 'database.sqlite');
    await manager.initialize(requirements, {
      ...config.connectors,
      sqlite: { dialect: 'sqlite', storage }
    });
    const database = manager.registry.get('sqlite') as Sequelize;
    assert.equal(database.getDialect(), 'sqlite');
    // Exercise DBLog's opt-in storage path without starting the game runtime or services.
    const dbLog = new DbLog(database, { serverID: 1, serverName: 'SQLite default fixture' });
    await dbLog.initialize();
    await dbLog.playerConnected({
      eosID: asEOSID('11111111111111111111111111111111'),
      steamID: asSteamID('76561198000000001'),
      name: 'Fixture'
    });
    await dbLog.stop();
    await manager.stop();
    await manager.initialize(requirements, { sqlite: { dialect: 'sqlite', storage } });
    const reopened = manager.registry.get('sqlite') as Sequelize;
    const rows = await reopened.query('SELECT eosID, steamID FROM DBLog_Players', {
      type: QueryTypes.SELECT
    });
    assert.deepEqual(rows, [
      { eosID: '11111111111111111111111111111111', steamID: '76561198000000001' }
    ]);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});
