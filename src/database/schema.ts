import { DataTypes, type Sequelize, type TableName } from 'sequelize';

import type { EosBackfillState } from './eos-backfill.js';

export const DBLOG_TABLES = [
  'DBLog_Metadata',
  'DBLog_Revives',
  'DBLog_Deaths',
  'DBLog_Wounds',
  'DBLog_PlayerCounts',
  'DBLog_TickRates',
  'DBLog_Matches',
  'DBLog_Players',
  'DBLog_SteamUsers',
  'DBLog_Servers'
] as const;

export const EOS_EVENT_INDEXES = [
  ['DBLog_Wounds', 'attackerEOSID'],
  ['DBLog_Wounds', 'victimEOSID'],
  ['DBLog_Deaths', 'attackerEOSID'],
  ['DBLog_Deaths', 'victimEOSID'],
  ['DBLog_Revives', 'attackerEOSID'],
  ['DBLog_Revives', 'victimEOSID'],
  ['DBLog_Revives', 'reviverEOSID']
] as const;

export async function createDbLogSchema(
  sequelize: Sequelize,
  options: { readonly legacy?: boolean } = {}
): Promise<void> {
  const legacy = options.legacy ?? false;
  const query = sequelize.getQueryInterface();
  const table = (name: string): TableName => dbLogTableName(sequelize, name);
  const id = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true };
  const serverReference = {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: table('DBLog_Servers'), key: 'id' },
    onDelete: 'CASCADE'
  };
  const matchReference = {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: table('DBLog_Matches'), key: 'id' },
    onDelete: 'CASCADE'
  };
  const playerReference = {
    type: DataTypes.STRING,
    allowNull: true,
    references: { model: table('DBLog_Players'), key: 'steamID' },
    onDelete: 'CASCADE'
  };

  await query.createTable(table('DBLog_Servers'), {
    id,
    name: { type: DataTypes.STRING }
  });
  await query.createTable(table('DBLog_SteamUsers'), {
    steamID: { type: DataTypes.STRING, primaryKey: true },
    lastName: { type: DataTypes.STRING }
  });
  await query.createTable(table('DBLog_Players'), {
    id,
    eosID: { type: DataTypes.STRING, allowNull: true, unique: true },
    steamID: { type: DataTypes.STRING, allowNull: !legacy, unique: true },
    lastName: { type: DataTypes.STRING },
    lastIP: { type: DataTypes.STRING }
  });
  await query.createTable(table('DBLog_Matches'), {
    id,
    dlc: { type: DataTypes.STRING },
    mapClassname: { type: DataTypes.STRING },
    layerClassname: { type: DataTypes.STRING },
    map: { type: DataTypes.STRING },
    layer: { type: DataTypes.STRING },
    startTime: { type: DataTypes.DATE },
    endTime: { type: DataTypes.DATE },
    winner: { type: DataTypes.STRING },
    winnernum: { type: DataTypes.INTEGER },
    team1faction: { type: DataTypes.STRING },
    team1unit: { type: DataTypes.STRING },
    team1tickets: { type: DataTypes.INTEGER },
    team2faction: { type: DataTypes.STRING },
    team2unit: { type: DataTypes.STRING },
    team2tickets: { type: DataTypes.INTEGER },
    server: serverReference
  });
  await query.createTable(table('DBLog_TickRates'), {
    id,
    time: { type: DataTypes.DATE },
    tickRate: { type: DataTypes.FLOAT },
    server: serverReference,
    match: matchReference
  });
  await query.createTable(table('DBLog_PlayerCounts'), {
    id,
    time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    players: { type: DataTypes.INTEGER },
    publicQueue: { type: DataTypes.INTEGER },
    reserveQueue: { type: DataTypes.INTEGER },
    server: serverReference,
    match: matchReference
  });

  const combatColumns = {
    id,
    time: { type: DataTypes.DATE },
    victim: playerReference,
    victimName: { type: DataTypes.STRING },
    victimTeamID: { type: DataTypes.INTEGER },
    victimSquadID: { type: DataTypes.INTEGER },
    attacker: playerReference,
    attackerName: { type: DataTypes.STRING },
    attackerTeamID: { type: DataTypes.INTEGER },
    attackerSquadID: { type: DataTypes.INTEGER },
    damage: { type: DataTypes.FLOAT },
    weapon: { type: DataTypes.STRING },
    teamkill: { type: DataTypes.BOOLEAN },
    server: serverReference,
    match: matchReference,
    ...(legacy
      ? {}
      : {
          attackerEOSID: { type: DataTypes.STRING, allowNull: true },
          victimEOSID: { type: DataTypes.STRING, allowNull: true }
        })
  };
  await query.createTable(table('DBLog_Wounds'), combatColumns);
  await query.createTable(table('DBLog_Deaths'), {
    ...combatColumns,
    woundTime: { type: DataTypes.DATE }
  });
  await query.createTable(table('DBLog_Revives'), {
    ...combatColumns,
    woundTime: { type: DataTypes.DATE },
    reviver: playerReference,
    reviverName: { type: DataTypes.STRING },
    reviverTeamID: { type: DataTypes.INTEGER },
    reviverSquadID: { type: DataTypes.INTEGER },
    ...(legacy ? {} : { reviverEOSID: { type: DataTypes.STRING, allowNull: true } })
  });

  if (!legacy) {
    await addQueryIndexes(sequelize);
    await addLatestIndexes(sequelize);
    await createMetadataTable(sequelize, 1, {
      version: 1,
      status: 'complete',
      tableIndex: 3,
      cursor: 0,
      highWaterMarks: {},
      completedIndexes: EOS_EVENT_INDEXES.map(([tableName, column]) =>
        eosIndexName(tableName, column)
      ),
      updatedAt: new Date().toISOString()
    });
  }
}

export async function addQueryIndexes(sequelize: Sequelize): Promise<void> {
  const query = sequelize.getQueryInterface();
  for (const [table, columns] of [
    ['DBLog_Matches', ['server', 'endTime', 'startTime']],
    ['DBLog_TickRates', ['time']],
    ['DBLog_TickRates', ['match']],
    ['DBLog_PlayerCounts', ['time']],
    ['DBLog_PlayerCounts', ['match']],
    ['DBLog_Wounds', ['match']],
    ['DBLog_Wounds', ['attacker', 'time']],
    ['DBLog_Wounds', ['victim', 'time']],
    ['DBLog_Deaths', ['match']],
    ['DBLog_Deaths', ['attacker', 'time']],
    ['DBLog_Deaths', ['victim', 'time']],
    ['DBLog_Revives', ['match']],
    ['DBLog_Revives', ['attacker', 'time']],
    ['DBLog_Revives', ['victim', 'time']],
    ['DBLog_Revives', ['reviver', 'time']]
  ] as const) {
    await query.addIndex(dbLogTableName(sequelize, table), [...columns], {
      name: `${table}_${columns.join('_')}`
    });
  }
}

export async function createMetadataTable(
  sequelize: Sequelize,
  version: number,
  eosBackfillState?: EosBackfillState
): Promise<void> {
  const query = sequelize.getQueryInterface();
  const table = dbLogTableName(sequelize, 'DBLog_Metadata');
  await query.createTable(table, {
    key: { type: DataTypes.STRING, primaryKey: true },
    value: { type: DataTypes.TEXT, allowNull: false }
  });
  await query.bulkInsert(table, [
    { key: 'schemaVersion', value: String(version) },
    ...(eosBackfillState ? [{ key: 'eosBackfillV1', value: JSON.stringify(eosBackfillState) }] : [])
  ]);
}

export async function addLatestIndexes(sequelize: Sequelize): Promise<void> {
  const query = sequelize.getQueryInterface();
  for (const [table, column] of EOS_EVENT_INDEXES) {
    const indexes = (await query.showIndex(dbLogTableName(sequelize, table))) as {
      readonly fields?: readonly { readonly attribute?: string; readonly name?: string }[];
    }[];
    const exists = indexes.some((index) =>
      index.fields?.some((field) => (field.attribute ?? field.name) === column)
    );
    if (!exists) {
      await query.addIndex(dbLogTableName(sequelize, table), [column], {
        name: eosIndexName(table, column)
      });
    }
  }
}

export function eosIndexName(tableName: string, column: string): string {
  return `${tableName}_${column}`;
}

export async function dropDbLogSchema(sequelize: Sequelize): Promise<void> {
  const query = sequelize.getQueryInterface();
  const existing = new Set(await normalizedTableNames(sequelize));
  for (const table of DBLOG_TABLES) {
    if (existing.has(table)) await query.dropTable(dbLogTableName(sequelize, table));
  }
}

export async function normalizedTableNames(sequelize: Sequelize): Promise<string[]> {
  const query = sequelize.getQueryInterface();
  const existing: string[] = [];
  for (const table of DBLOG_TABLES) {
    if (await query.tableExists(dbLogTableName(sequelize, table))) existing.push(table);
  }
  return existing;
}

export function configuredDbSchema(sequelize: Sequelize): string | undefined {
  if (sequelize.getDialect() !== 'postgres') return undefined;
  const schema = (sequelize as unknown as { options?: { schema?: unknown } }).options?.schema;
  return typeof schema === 'string' && schema ? schema : undefined;
}

export function dbLogTableName(sequelize: Sequelize, tableName: string): TableName {
  const schema = configuredDbSchema(sequelize);
  return schema ? { tableName, schema, delimiter: '.' } : tableName;
}

export function quoteDbLogTable(sequelize: Sequelize, tableName: string): string {
  const quote = (identifier: string): string =>
    sequelize.getQueryInterface().quoteIdentifier(identifier);
  const schema = configuredDbSchema(sequelize);
  return schema ? `${quote(schema)}.${quote(tableName)}` : quote(tableName);
}
