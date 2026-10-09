import { DataTypes, QueryTypes, type Sequelize } from 'sequelize';
import {
  createDbLogSchema,
  createMetadataTable,
  dbLogTableName,
  normalizedTableNames,
  quoteDbLogTable
} from './schema.js';
import {
  completedEosBackfillState,
  ensureEosBackfillState,
  pendingEosBackfillState
} from './eos-backfill.js';

export const DBLOG_SCHEMA_VERSION = 1;

export type DbLogSchemaChange =
  | { readonly kind: 'create'; readonly toVersion: number }
  | { readonly kind: 'migrate'; readonly fromVersion: 'legacy'; readonly toVersion: number };

const LEGACY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  DBLog_Servers: ['id', 'name'],
  DBLog_Matches: ['id', 'startTime', 'endTime', 'server'],
  DBLog_TickRates: ['id', 'time', 'tickRate', 'server', 'match'],
  DBLog_PlayerCounts: ['id', 'time', 'players', 'publicQueue', 'reserveQueue', 'server', 'match'],
  DBLog_SteamUsers: ['steamID', 'lastName'],
  DBLog_Players: ['id', 'eosID', 'steamID', 'lastName', 'lastIP'],
  DBLog_Wounds: ['id', 'time', 'attacker', 'victim', 'server', 'match'],
  DBLog_Deaths: ['id', 'time', 'woundTime', 'attacker', 'victim', 'server', 'match'],
  DBLog_Revives: ['id', 'time', 'attacker', 'victim', 'reviver', 'server', 'match']
};

export async function migrateDbLog(
  sequelize: Sequelize,
  onSchemaChange?: (change: DbLogSchemaChange) => void
): Promise<number> {
  const tableNames = new Set(await normalizedTableNames(sequelize));
  const knownTables = [...tableNames].filter((name) => name.startsWith('DBLog_'));
  if (knownTables.length === 0) {
    onSchemaChange?.({ kind: 'create', toVersion: DBLOG_SCHEMA_VERSION });
    await createDbLogSchema(sequelize);
    return DBLOG_SCHEMA_VERSION;
  }

  if (!tableNames.has('DBLog_Metadata')) {
    await assertLegacyBaseline(sequelize, tableNames);
    onSchemaChange?.({
      kind: 'migrate',
      fromVersion: 'legacy',
      toVersion: DBLOG_SCHEMA_VERSION
    });
    await migrateLegacyStructureToVersion1(sequelize);
    return DBLOG_SCHEMA_VERSION;
  }

  const rows = (await sequelize.query(
    `SELECT ${quote(sequelize, 'value')} AS ${quote(sequelize, 'value')} FROM ${quoteDbLogTable(
      sequelize,
      'DBLog_Metadata'
    )} WHERE ${quote(sequelize, 'key')} = 'schemaVersion'`,
    { type: QueryTypes.SELECT }
  )) as { value?: string }[];
  const version = Number(rows[0]?.value);
  if (!Number.isInteger(version)) throw new Error('DBLog schema version is missing or invalid');
  if (version > DBLOG_SCHEMA_VERSION) {
    throw new Error(
      `DBLog schema version ${version} is newer than supported version ${DBLOG_SCHEMA_VERSION}`
    );
  }
  if (version < DBLOG_SCHEMA_VERSION) {
    throw new Error(`No DBLog migration path from schema version ${version}`);
  }
  await assertVersion1Schema(sequelize, tableNames);
  await ensureMetadataTextValue(sequelize);
  await ensureEosBackfillState(sequelize, completedEosBackfillState());
  return version;
}

async function assertLegacyBaseline(sequelize: Sequelize, tables: Set<string>): Promise<void> {
  for (const [table, columns] of Object.entries(LEGACY_COLUMNS)) {
    if (!tables.has(table)) throw new Error(`Unversioned DBLog schema is missing table ${table}`);
    const description = await sequelize
      .getQueryInterface()
      .describeTable(dbLogTableName(sequelize, table));
    for (const column of columns) {
      if (!(column in description)) {
        throw new Error(`Unversioned DBLog schema is missing column ${table}.${column}`);
      }
    }
  }
}

async function migrateLegacyStructureToVersion1(sequelize: Sequelize): Promise<void> {
  const query = sequelize.getQueryInterface();
  if (sequelize.getDialect() === 'sqlite') await makeSqliteSteamIDNullable(sequelize);
  else {
    const players = await query.describeTable(dbLogTableName(sequelize, 'DBLog_Players'));
    if (players.steamID?.allowNull !== true) {
      await query.changeColumn(dbLogTableName(sequelize, 'DBLog_Players'), 'steamID', {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true
      });
    }
  }

  for (const [table, column] of [
    ['DBLog_Wounds', 'attackerEOSID'],
    ['DBLog_Wounds', 'victimEOSID'],
    ['DBLog_Deaths', 'attackerEOSID'],
    ['DBLog_Deaths', 'victimEOSID'],
    ['DBLog_Revives', 'attackerEOSID'],
    ['DBLog_Revives', 'victimEOSID'],
    ['DBLog_Revives', 'reviverEOSID']
  ] as const) {
    const description = await query.describeTable(dbLogTableName(sequelize, table));
    if (!(column in description)) {
      await query.addColumn(dbLogTableName(sequelize, table), column, {
        type: DataTypes.STRING,
        allowNull: true
      });
    }
  }

  await createMetadataTable(sequelize, DBLOG_SCHEMA_VERSION, pendingEosBackfillState());
}

async function makeSqliteSteamIDNullable(sequelize: Sequelize): Promise<void> {
  const q = (value: string): string => quote(sequelize, value);
  await sequelize.query('PRAGMA foreign_keys = OFF');
  try {
    await sequelize.query(
      `CREATE TABLE ${q('DBLog_Players_v1')} (` +
        `${q('id')} INTEGER PRIMARY KEY AUTOINCREMENT, ` +
        `${q('eosID')} VARCHAR(255) UNIQUE, ` +
        `${q('steamID')} VARCHAR(255) UNIQUE, ` +
        `${q('lastName')} VARCHAR(255), ` +
        `${q('lastIP')} VARCHAR(255))`
    );
    await sequelize.query(
      `INSERT INTO ${q('DBLog_Players_v1')} (${q('id')}, ${q('eosID')}, ${q('steamID')}, ${q(
        'lastName'
      )}, ${q('lastIP')}) SELECT ${q('id')}, ${q('eosID')}, ${q('steamID')}, ${q('lastName')}, ${q(
        'lastIP'
      )} FROM ${q('DBLog_Players')}`
    );
    await sequelize.query(`DROP TABLE ${q('DBLog_Players')}`);
    await sequelize.query(`ALTER TABLE ${q('DBLog_Players_v1')} RENAME TO ${q('DBLog_Players')}`);
  } finally {
    await sequelize.query('PRAGMA foreign_keys = ON');
  }
}

async function assertVersion1Schema(sequelize: Sequelize, tables: Set<string>): Promise<void> {
  await assertLegacyBaseline(sequelize, tables);
  for (const [table, columns] of Object.entries({
    DBLog_Wounds: ['attackerEOSID', 'victimEOSID'],
    DBLog_Deaths: ['attackerEOSID', 'victimEOSID'],
    DBLog_Revives: ['attackerEOSID', 'victimEOSID', 'reviverEOSID']
  })) {
    const description = await sequelize
      .getQueryInterface()
      .describeTable(dbLogTableName(sequelize, table));
    for (const column of columns) {
      if (!(column in description)) {
        throw new Error(`DBLog schema version 1 is missing column ${table}.${column}`);
      }
    }
  }
}

async function ensureMetadataTextValue(sequelize: Sequelize): Promise<void> {
  const query = sequelize.getQueryInterface();
  const description = await query.describeTable(dbLogTableName(sequelize, 'DBLog_Metadata'));
  const valueType = description.value?.type.toUpperCase() ?? '';
  if (valueType.includes('TEXT')) return;
  await query.changeColumn(dbLogTableName(sequelize, 'DBLog_Metadata'), 'value', {
    type: DataTypes.TEXT,
    allowNull: false
  });
}

function quote(sequelize: Sequelize, identifier: string): string {
  return sequelize.getQueryInterface().quoteIdentifier(identifier);
}
