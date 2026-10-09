import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryTypes, Sequelize } from 'sequelize';
import { asEOSID, asSteamID } from '../../src/domain/identity.js';
import { DbLog } from '../../src/database/db-log.js';
import { readEosBackfillState, runEosBackfill } from '../../src/database/eos-backfill.js';
import {
  DBLOG_SCHEMA_VERSION,
  migrateDbLog,
  type DbLogSchemaChange
} from '../../src/database/migrations.js';
import {
  createDbLogSchema,
  dbLogTableName,
  dropDbLogSchema,
  quoteDbLogTable
} from '../../src/database/schema.js';

interface DialectCase {
  readonly name: string;
  readonly create: () => Sequelize;
  readonly enabled: boolean;
}

const dialects: DialectCase[] = [
  {
    name: 'sqlite',
    enabled: true,
    create: () => new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
  },
  {
    name: 'postgres',
    enabled: Boolean(process.env.DB_TEST_POSTGRES_URL),
    create: () =>
      new Sequelize(process.env.DB_TEST_POSTGRES_URL!, {
        logging: false,
        ...(process.env.DB_TEST_POSTGRES_SCHEMA
          ? { schema: process.env.DB_TEST_POSTGRES_SCHEMA }
          : {})
      })
  },
  {
    name: 'mariadb',
    enabled: Boolean(process.env.DB_TEST_MARIADB_URL),
    create: () => new Sequelize(process.env.DB_TEST_MARIADB_URL!, { logging: false })
  }
];

for (const dialect of dialects) {
  test(
    `DBLog empty schema, legacy migration, and EOS-only writes (${dialect.name})`,
    { skip: !dialect.enabled },
    async () => {
      const sequelize = dialect.create();
      try {
        await sequelize.authenticate();
        await dropDbLogSchema(sequelize);
        await runEmptyDatabaseCase(sequelize);
        await dropDbLogSchema(sequelize);
        await runPlayerIdentityReconciliationCase(sequelize);
        await dropDbLogSchema(sequelize);
        await runLegacyMigrationCase(sequelize);
      } finally {
        await sequelize.close();
      }
    }
  );
}

async function runEmptyDatabaseCase(sequelize: Sequelize): Promise<void> {
  const changes: DbLogSchemaChange[] = [];
  assert.equal(
    await migrateDbLog(sequelize, (change) => changes.push(change)),
    DBLOG_SCHEMA_VERSION
  );
  assert.deepEqual(changes, [{ kind: 'create', toVersion: DBLOG_SCHEMA_VERSION }]);
  assert.equal(
    await migrateDbLog(sequelize, (change) => changes.push(change)),
    DBLOG_SCHEMA_VERSION
  );
  assert.equal(changes.length, 1);
  assert.equal((await readEosBackfillState(sequelize)).status, 'complete');
  const woundColumns = await sequelize
    .getQueryInterface()
    .describeTable(dbLogTableName(sequelize, 'DBLog_Wounds'));
  assert.ok('attackerEOSID' in woundColumns);
  assert.ok('victimEOSID' in woundColumns);
  await assertIndex(sequelize, 'DBLog_Matches', ['server', 'endTime', 'startTime']);
  await assertIndex(sequelize, 'DBLog_Deaths', ['match']);
  await assertIndex(sequelize, 'DBLog_Deaths', ['attacker', 'time']);
  await assertIndex(sequelize, 'DBLog_Revives', ['reviver', 'time']);

  const eosID = asEOSID('11111111111111111111111111111111');
  const dbLog = new DbLog(sequelize, { serverID: 1, serverName: 'Test Server' });
  await dbLog.initialize();
  await dbLog.playerConnected({ eosID, name: 'EOS Only' });
  await dbLog.startMatch({
    time: new Date('2026-08-15T12:00:00Z'),
    dlc: 'Game',
    mapClassname: 'TestMap',
    layerClassname: 'TestLayer'
  });
  await dbLog.wound({
    time: new Date('2026-08-15T12:01:00Z'),
    victim: { eosID, name: 'EOS Only' },
    damage: 10,
    weapon: 'TestWeapon'
  });
  await dbLog.death({
    time: new Date('2026-08-15T12:01:30Z'),
    woundTime: new Date('2026-08-15T12:01:00Z'),
    victim: { eosID, name: 'EOS Only' },
    damage: 10,
    weapon: 'TestWeapon'
  });
  await dbLog.revive({
    time: new Date('2026-08-15T12:01:45Z'),
    woundTime: new Date('2026-08-15T12:01:00Z'),
    victim: { eosID, name: 'EOS Only' },
    reviver: { eosID, name: 'EOS Only' }
  });
  await dbLog.tickRate(new Date('2026-08-15T12:01:01Z'), 49.5);
  await dbLog.playerCount(new Date('2026-08-15T12:01:02Z'), 1, 0, 0);
  assert.equal(dbLog.playerUpserts, 2);
  assert.equal(dbLog.playerUpsertSkips, 3);
  await dbLog.stop();

  const recovered = new DbLog(sequelize, { serverID: 1, serverName: 'Test Server' });
  await recovered.initialize();
  assert.equal(recovered.currentMatchID, dbLog.currentMatchID);
  await recovered.endMatch({ time: new Date('2026-08-15T12:02:00Z'), winnerTeam: 1 });
  await recovered.stop();

  const players = (await sequelize.query(
    `SELECT ${columns(sequelize, ['eosID', 'steamID', 'lastName'])} FROM ${table(
      sequelize,
      'DBLog_Players'
    )}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.equal(players[0]?.eosID, eosID);
  assert.equal(players[0]?.steamID, null);

  const wounds = (await sequelize.query(
    `SELECT ${columns(sequelize, ['victim', 'victimEOSID', 'victimName'])} FROM ${table(
      sequelize,
      'DBLog_Wounds'
    )}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.equal(wounds[0]?.victim, null);
  assert.equal(wounds[0]?.victimEOSID, eosID);
  assert.equal(wounds[0]?.victimName, 'EOS Only');

  for (const [eventTable, eosColumn] of [
    ['DBLog_Deaths', 'victimEOSID'],
    ['DBLog_Revives', 'reviverEOSID']
  ] as const) {
    const rows = (await sequelize.query(
      `SELECT ${columns(sequelize, [eosColumn])} FROM ${table(sequelize, eventTable)}`,
      { type: QueryTypes.SELECT }
    )) as Record<string, unknown>[];
    assert.equal(rows[0]?.[eosColumn], eosID);
  }
}

async function runLegacyMigrationCase(sequelize: Sequelize): Promise<void> {
  await createDbLogSchema(sequelize, { legacy: true });
  const query = sequelize.getQueryInterface();
  const eosID = asEOSID('22222222222222222222222222222222');
  const steamID = asSteamID('76561198000000001');
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Servers'), [
    { id: 7, name: 'Legacy Server' }
  ]);
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Players'), [
    { eosID, steamID, lastName: 'Legacy Player', lastIP: null }
  ]);
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Matches'), [
    {
      id: 9,
      server: 7,
      mapClassname: 'Gorodok',
      layerClassname: 'Gorodok_RAAS_v1',
      map: null,
      layer: 'Previous Map',
      startTime: new Date('2026-08-22T00:00:00Z')
    }
  ]);
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Wounds'), [
    {
      server: 7,
      match: 9,
      time: new Date('2026-08-14T00:00:00Z'),
      attacker: steamID,
      attackerName: 'Legacy Player',
      victim: steamID,
      victimName: 'Legacy Player',
      damage: 1,
      teamkill: false
    }
  ]);

  const changes: DbLogSchemaChange[] = [];
  assert.equal(
    await migrateDbLog(sequelize, (change) => changes.push(change)),
    DBLOG_SCHEMA_VERSION
  );
  assert.deepEqual(changes, [
    { kind: 'migrate', fromVersion: 'legacy', toVersion: DBLOG_SCHEMA_VERSION }
  ]);
  const repairingDbLog = new DbLog(sequelize, { serverID: 7, serverName: 'Legacy Server' });
  await repairingDbLog.initialize();
  await repairingDbLog.stop();
  const migratedMatches = (await sequelize.query(
    `SELECT ${columns(sequelize, ['map', 'layer'])} FROM ${table(sequelize, 'DBLog_Matches')}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.equal(migratedMatches[0]?.map, 'Gorodok');
  assert.equal(migratedMatches[0]?.layer, 'Gorodok_RAAS_v1');
  const beforeBackfill = (await sequelize.query(
    `SELECT ${columns(sequelize, [
      'attacker',
      'victim',
      'attackerEOSID',
      'victimEOSID'
    ])} FROM ${table(sequelize, 'DBLog_Wounds')}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.equal(beforeBackfill[0]?.attacker, steamID);
  assert.equal(beforeBackfill[0]?.victim, steamID);
  assert.equal(beforeBackfill[0]?.attackerEOSID, null);
  assert.equal(beforeBackfill[0]?.victimEOSID, null);
  assert.equal((await readEosBackfillState(sequelize)).status, 'pending');
  const preBackfillIndexes = (await sequelize
    .getQueryInterface()
    .showIndex(dbLogTableName(sequelize, 'DBLog_Wounds'))) as {
    readonly name?: string;
  }[];
  assert.equal(
    preBackfillIndexes.some((index) => index.name === 'DBLog_Wounds_attackerEOSID'),
    false
  );

  const completed = await runEosBackfill(sequelize, {
    mode: 'background',
    batchSize: 100,
    pauseMs: 0,
    runForMinutes: 0
  });
  assert.equal(completed.status, 'complete');

  const afterBackfill = (await sequelize.query(
    `SELECT ${columns(sequelize, [
      'attackerEOSID',
      'victimEOSID'
    ])} FROM ${table(sequelize, 'DBLog_Wounds')}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.equal(afterBackfill[0]?.attackerEOSID, eosID);
  assert.equal(afterBackfill[0]?.victimEOSID, eosID);
  await assertIndex(sequelize, 'DBLog_Wounds', ['attackerEOSID']);
  await assertIndex(sequelize, 'DBLog_Revives', ['reviverEOSID']);

  const legacyQuery = (await sequelize.query(
    `SELECT ${columns(sequelize, ['attacker', 'attackerName'])}, COUNT(*) AS wounds FROM ${table(
      sequelize,
      'DBLog_Wounds'
    )} GROUP BY ${columns(sequelize, ['attacker', 'attackerName'])}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.equal(legacyQuery[0]?.attacker, steamID);
  assert.equal(Number(legacyQuery[0]?.wounds), 1);

  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Players'), [
    {
      eosID: '33333333333333333333333333333333',
      steamID: null,
      lastName: 'Migrated EOS Only',
      lastIP: null
    }
  ]);
}

async function runPlayerIdentityReconciliationCase(sequelize: Sequelize): Promise<void> {
  await migrateDbLog(sequelize);
  const query = sequelize.getQueryInterface();
  const eosID = asEOSID('44444444444444444444444444444444');
  const staleEOSID = asEOSID('55555555555555555555555555555555');
  const steamID = asSteamID('76561198000000002');
  const previousSteamID = asSteamID('76561198000000003');
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Servers'), [
    { id: 8, name: 'Identity Server' }
  ]);
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Players'), [
    {
      eosID,
      steamID: previousSteamID,
      lastName: 'Previous Steam Mapping',
      lastIP: null
    },
    { eosID: staleEOSID, steamID, lastName: 'Current Steam Row', lastIP: null }
  ]);
  await query.bulkInsert(dbLogTableName(sequelize, 'DBLog_Wounds'), [
    {
      server: 8,
      time: new Date('2026-08-25T20:00:00Z'),
      attacker: previousSteamID,
      attackerEOSID: eosID,
      attackerName: 'Previous Steam Mapping',
      victim: steamID,
      victimEOSID: staleEOSID,
      victimName: 'Current Steam Row',
      damage: 1,
      teamkill: false
    }
  ]);

  const dbLog = new DbLog(sequelize, { serverID: 8, serverName: 'Identity Server' });
  await dbLog.initialize();
  await dbLog.playerConnected({ eosID, steamID, name: 'Current Player', ip: '192.0.2.10' });
  await dbLog.wound({
    time: new Date('2026-08-25T21:00:00Z'),
    victim: { eosID, steamID, name: 'Current Player' },
    damage: 10,
    weapon: 'TestWeapon'
  });
  await dbLog.playerConnected({ eosID, name: 'Current Player Without Steam Metadata' });
  await dbLog.stop();

  const players = (await sequelize.query(
    `SELECT ${columns(sequelize, ['eosID', 'steamID', 'lastName', 'lastIP'])} FROM ${table(
      sequelize,
      'DBLog_Players'
    )} ORDER BY ${columns(sequelize, ['steamID'])}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.deepEqual(players, [
    {
      eosID,
      steamID,
      lastName: 'Current Player Without Steam Metadata',
      lastIP: '192.0.2.10'
    },
    {
      eosID: null,
      steamID: previousSteamID,
      lastName: 'Previous Steam Mapping',
      lastIP: null
    }
  ]);

  const wounds = (await sequelize.query(
    `SELECT ${columns(sequelize, [
      'attacker',
      'victim',
      'victimEOSID'
    ])} FROM ${table(sequelize, 'DBLog_Wounds')} ORDER BY ${columns(sequelize, ['id'])}`,
    { type: QueryTypes.SELECT }
  )) as Record<string, unknown>[];
  assert.equal(wounds.length, 2);
  assert.equal(wounds[0]?.attacker, previousSteamID);
  assert.equal(wounds[0]?.victim, steamID);
  assert.equal(wounds[1]?.victim, steamID);
  assert.equal(wounds[1]?.victimEOSID, eosID);
}

function table(sequelize: Sequelize, name: string): string {
  return quoteDbLogTable(sequelize, name);
}

function columns(sequelize: Sequelize, names: readonly string[]): string {
  return names.map((name) => sequelize.getQueryInterface().quoteIdentifier(name)).join(', ');
}

async function assertIndex(
  sequelize: Sequelize,
  tableName: string,
  expectedColumns: readonly string[]
): Promise<void> {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex(dbLogTableName(sequelize, tableName))) as {
    readonly fields?: readonly { readonly attribute?: string; readonly name?: string }[];
  }[];
  assert.ok(
    indexes.some((index) =>
      expectedColumns.every(
        (column, position) =>
          (index.fields?.[position]?.attribute ?? index.fields?.[position]?.name) === column
      )
    ),
    `${tableName} is missing index (${expectedColumns.join(', ')})`
  );
}
