import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import Sequelize from 'sequelize';

interface PlayerStateTrackerPlugin {
  database: Sequelize.Sequelize;
  models: { Session: Sequelize.ModelStatic<Sequelize.Model> };
  pendingClosedSessions: Set<Record<string, unknown>>;
  mount(): Promise<void>;
  unmount(): Promise<void>;
  evaluateStateSnapshot(): Promise<void>;
  flushStateToDatabase(): Promise<void>;
  onNewGame(info: Record<string, unknown>): Promise<void>;
}

async function createPlugin(
  options: Record<string, unknown> = {},
  databaseMode: 'explicit' | 'fallback' | 'missing' = 'fallback'
) {
  const [{ default: PlayerStateTracker }, { default: DBLog }] = (await Promise.all([
    import(pathToFileURL(resolve('squad-server/plugins/player-state-tracker.js')).href),
    import(pathToFileURL(resolve('squad-server/plugins/db-log.js')).href)
  ])) as [
    {
      default: new (
        server: unknown,
        options: Record<string, unknown>,
        connectors: Record<string, unknown>
      ) => PlayerStateTrackerPlugin;
    },
    { default: new (...arguments_: unknown[]) => object }
  ];
  const database = new Sequelize.Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });
  const dbLog = Object.create(DBLog.prototype) as {
    options: Record<string, unknown>;
    models: Record<string, unknown>;
    match: { id: number };
  };
  dbLog.options = { database };
  dbLog.models = { Match: { findOne: async () => null } };
  dbLog.match = { id: 100 };

  const server = new EventEmitter() as EventEmitter & {
    id: number;
    players: Record<string, unknown>[];
    squads: Record<string, unknown>[];
    plugins: object[];
  };
  server.id = 1;
  server.players = [
    {
      eosID: 'eos-leader',
      steamID: 'steam-leader',
      name: 'Leader',
      teamID: 1,
      squadID: 1,
      isLeader: true
    }
  ];
  server.squads = [{ teamID: 1, squadID: 1, squadName: 'Test Squad', size: 3, locked: false }];
  server.plugins = databaseMode === 'fallback' ? [dbLog] : [];

  const rawOptions = {
    seedingMinPlayers: 1,
    liveTarget: 1,
    seedingReopenBelow: 1,
    seedingReopenDelayMinutes: 1,
    minUnlockedSquadSize: 3,
    ...(databaseMode === 'explicit' ? { database: 'tracker-database' } : {}),
    ...options
  };

  const plugin = new PlayerStateTracker(
    server,
    rawOptions,
    databaseMode === 'explicit' ? { 'tracker-database': database } : {}
  );
  try {
    await plugin.mount();
  } catch (error) {
    await database.close();
    throw error;
  }
  return { database, plugin, server };
}

test('PlayerStateTracker uses an explicit connector without DBLog', async () => {
  const context = await createPlugin({}, 'explicit');
  try {
    assert.equal(context.plugin.database, context.database);
    const rows = await context.plugin.models.Session.findAll();
    assert.equal(rows.length, 1);
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('PlayerStateTracker rejects missing explicit and DBLog fallback databases', async () => {
  await assert.rejects(
    createPlugin({}, 'missing'),
    /requires a database connector or an enabled DBLog fallback/
  );
});

test('PlayerStateTracker closes every rapid exit and re-entry session', async () => {
  const context = await createPlugin();
  try {
    context.server.squads[0]!.locked = true;
    await context.plugin.evaluateStateSnapshot();
    context.server.squads[0]!.locked = false;
    await context.plugin.evaluateStateSnapshot();
    context.server.squads[0]!.locked = true;
    await context.plugin.evaluateStateSnapshot();

    assert.equal(context.plugin.pendingClosedSessions.size, 2);
    await context.plugin.flushStateToDatabase();

    const rows = await context.plugin.models.Session.findAll({ order: [['id', 'ASC']] });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.get('closedAt') instanceof Date));
    assert.equal(context.plugin.pendingClosedSessions.size, 0);
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('PlayerStateTracker starts the new-round seeding session without a timer gap', async () => {
  const context = await createPlugin({ liveTarget: 70, seedingReopenBelow: 65 });
  try {
    await context.plugin.onNewGame({ time: new Date() });
    const rows = await context.plugin.models.Session.findAll({ order: [['id', 'ASC']] });
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.get('closedAt') instanceof Date);
    assert.equal(rows[1]!.get('closedAt'), null);
    assert.equal(rows[1]!.get('state'), 'seeding');
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});
