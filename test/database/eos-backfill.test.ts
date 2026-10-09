import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryTypes, Sequelize } from 'sequelize';

import {
  parseEosBackfillOptions,
  readEosBackfillState,
  runEosBackfill,
  type EosBackfillProgress
} from '../../src/database/eos-backfill.js';
import { migrateDbLog } from '../../src/database/migrations.js';
import { createDbLogSchema, dbLogTableName, quoteDbLogTable } from '../../src/database/schema.js';

test('historical EOS backfill checkpoints, pauses, and resumes without rewriting legacy identity', async () => {
  const sequelize = await legacyDatabase(3);
  try {
    await migrateDbLog(sequelize);
    assert.equal((await readEosBackfillState(sequelize)).status, 'pending');

    const controller = new AbortController();
    const paused = await runEosBackfill(sequelize, {
      mode: 'background',
      batchSize: 1,
      pauseMs: 0,
      runForMinutes: 0,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.kind === 'batch') controller.abort();
      }
    });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.tableIndex, 0);
    assert.equal(paused.cursor, 1);

    const partial = await wounds(sequelize);
    assert.equal(partial[0]?.victimEOSID, EOS_ID);
    assert.equal(partial[1]?.victimEOSID, null);
    assert.equal(partial[1]?.victim, STEAM_ID);

    const completed = await runEosBackfill(sequelize, {
      mode: 'blocking',
      batchSize: 1,
      pauseMs: 0,
      runForMinutes: 0
    });
    assert.equal(completed.status, 'complete');
    assert.equal(completed.tableIndex, 3);
    assert.equal(
      (await wounds(sequelize)).every((row) => row.victimEOSID === EOS_ID),
      true
    );

    const indexes = (await sequelize
      .getQueryInterface()
      .showIndex(dbLogTableName(sequelize, 'DBLog_Wounds'))) as { readonly name?: string }[];
    assert.ok(indexes.some((index) => index.name === 'DBLog_Wounds_victimEOSID'));
  } finally {
    await sequelize.close();
  }
});

test('a live lease prevents a second blocking backfill worker', async () => {
  const sequelize = await legacyDatabase(2);
  try {
    await migrateDbLog(sequelize);
    const pending = await readEosBackfillState(sequelize);
    await sequelize.getQueryInterface().bulkUpdate(
      dbLogTableName(sequelize, 'DBLog_Metadata'),
      {
        value: JSON.stringify({
          ...pending,
          status: 'running',
          lease: {
            owner: 'another-instance',
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }
        })
      },
      { key: 'eosBackfillV1' }
    );

    const events: EosBackfillProgress[] = [];
    const second = await runEosBackfill(sequelize, {
      mode: 'blocking',
      batchSize: 1,
      pauseMs: 0,
      runForMinutes: 0,
      onProgress: (progress) => events.push(progress)
    });
    assert.equal(second.status, 'running');
    assert.equal(events[0]?.kind, 'busy');
  } finally {
    await sequelize.close();
  }
});

test('a background worker retries after another worker lease expires', async () => {
  const sequelize = await legacyDatabase(2);
  try {
    await migrateDbLog(sequelize);
    const pending = await readEosBackfillState(sequelize);
    await sequelize.getQueryInterface().bulkUpdate(
      dbLogTableName(sequelize, 'DBLog_Metadata'),
      {
        value: JSON.stringify({
          ...pending,
          status: 'running',
          lease: {
            owner: 'stopped-instance',
            expiresAt: new Date(Date.now() + 20).toISOString()
          }
        })
      },
      { key: 'eosBackfillV1' }
    );

    const events: EosBackfillProgress[] = [];
    const completed = await runEosBackfill(sequelize, {
      mode: 'background',
      batchSize: 1,
      pauseMs: 0,
      runForMinutes: 0,
      onProgress: (progress) => events.push(progress)
    });
    assert.equal(completed.status, 'complete');
    assert.equal(events[0]?.kind, 'busy');
    assert.ok(events.some((event) => event.kind === 'started'));
    assert.ok(events.some((event) => event.kind === 'complete'));
  } finally {
    await sequelize.close();
  }
});

test('backfill configuration defaults off and rejects unsafe ranges', () => {
  assert.deepEqual(parseEosBackfillOptions(undefined), {
    mode: 'off',
    batchSize: 5000,
    pauseMs: 500,
    runForMinutes: 0
  });
  assert.deepEqual(parseEosBackfillOptions({ mode: 'background', batchSize: 1000 }), {
    mode: 'background',
    batchSize: 1000,
    pauseMs: 500,
    runForMinutes: 0
  });
  assert.throws(() => parseEosBackfillOptions({ mode: 'automatic' }), /mode/);
  assert.throws(() => parseEosBackfillOptions({ batchSize: 1 }), /batchSize/);
});

const EOS_ID = '22222222222222222222222222222222';
const STEAM_ID = '76561198000000001';

async function legacyDatabase(woundCount: number): Promise<Sequelize> {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await createDbLogSchema(sequelize, { legacy: true });
  const query = sequelize.getQueryInterface();
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Servers'), [
    { id: 1, name: 'Legacy Server' }
  ]);
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Players'), [
    { eosID: EOS_ID, steamID: STEAM_ID, lastName: 'Legacy Player', lastIP: null }
  ]);
  await query.bulkInsert(
    dbLogTableName(sequelize, 'DBLog_Wounds'),
    Array.from({ length: woundCount }, (_, index) => ({
      id: index + 1,
      server: 1,
      match: null,
      time: new Date('2026-08-14T00:00:00Z'),
      attacker: STEAM_ID,
      attackerName: 'Legacy Player',
      victim: STEAM_ID,
      victimName: 'Legacy Player',
      damage: 1,
      teamkill: false
    }))
  );
  return sequelize;
}

async function wounds(sequelize: Sequelize): Promise<Record<string, unknown>[]> {
  const q = (identifier: string): string =>
    sequelize.getQueryInterface().quoteIdentifier(identifier);
  return sequelize.query(
    `SELECT ${q('id')}, ${q('victim')}, ${q('victimEOSID')} FROM ${quoteDbLogTable(
      sequelize,
      'DBLog_Wounds'
    )} ORDER BY ${q('id')}`,
    { type: QueryTypes.SELECT }
  ) as Promise<Record<string, unknown>[]>;
}
