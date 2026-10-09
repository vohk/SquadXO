import { randomUUID } from 'node:crypto';

import {
  DataTypes,
  Model,
  QueryTypes,
  Transaction,
  type ModelStatic,
  type Sequelize
} from 'sequelize';

import {
  EOS_EVENT_INDEXES,
  configuredDbSchema,
  dbLogTableName,
  eosIndexName,
  quoteDbLogTable
} from './schema.js';

export const EOS_BACKFILL_METADATA_KEY = 'eosBackfillV1';
export const EOS_BACKFILL_VERSION = 1;

const LEASE_DURATION_MS = 5 * 60_000;
const LEASE_REFRESH_MS = 60_000;

const EVENT_TABLES = [
  {
    name: 'DBLog_Wounds',
    columns: [
      ['attacker', 'attackerEOSID'],
      ['victim', 'victimEOSID']
    ]
  },
  {
    name: 'DBLog_Deaths',
    columns: [
      ['attacker', 'attackerEOSID'],
      ['victim', 'victimEOSID']
    ]
  },
  {
    name: 'DBLog_Revives',
    columns: [
      ['attacker', 'attackerEOSID'],
      ['victim', 'victimEOSID'],
      ['reviver', 'reviverEOSID']
    ]
  }
] as const;

export type EosBackfillMode = 'off' | 'background' | 'blocking';
export type EosBackfillStatus =
  'pending' | 'running' | 'paused' | 'indexing' | 'complete' | 'failed';

export interface EosBackfillState {
  readonly version: 1;
  readonly status: EosBackfillStatus;
  readonly tableIndex: number;
  readonly cursor: number;
  readonly highWaterMarks: Readonly<Record<string, number>>;
  readonly completedIndexes: readonly string[];
  readonly updatedAt: string;
  readonly lease?:
    | {
        readonly owner: string;
        readonly expiresAt: string;
      }
    | undefined;
  readonly error?: string | undefined;
}

export interface EosBackfillOptions {
  readonly mode: EosBackfillMode;
  readonly batchSize: number;
  readonly pauseMs: number;
  readonly runForMinutes: number;
}

export type EosBackfillProgress =
  | { readonly kind: 'busy'; readonly owner: string; readonly expiresAt: string }
  | { readonly kind: 'started'; readonly state: EosBackfillState }
  | {
      readonly kind: 'table';
      readonly table: string;
      readonly cursor: number;
      readonly highWaterMark: number;
    }
  | {
      readonly kind: 'batch';
      readonly table: string;
      readonly cursor: number;
      readonly highWaterMark: number;
      readonly scannedRows: number;
      readonly batchNumber: number;
      readonly durationMs: number;
    }
  | { readonly kind: 'index'; readonly index: string }
  | { readonly kind: 'paused'; readonly reason: 'shutdown' | 'time-limit' }
  | { readonly kind: 'complete' };

export interface RunEosBackfillOptions extends EosBackfillOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: EosBackfillProgress) => void;
}

export function parseEosBackfillOptions(value: unknown): EosBackfillOptions {
  if (value === undefined) {
    return { mode: 'off', batchSize: 5000, pauseMs: 500, runForMinutes: 0 };
  }
  if (!record(value)) throw new Error('DBLog.eosBackfill must be an object');
  const mode = value.mode ?? 'off';
  if (!['off', 'background', 'blocking'].includes(String(mode))) {
    throw new Error('DBLog.eosBackfill.mode must be off, background, or blocking');
  }
  return {
    mode: mode as EosBackfillMode,
    batchSize: boundedInteger(value.batchSize, 5000, 100, 100_000, 'batchSize'),
    pauseMs: boundedInteger(value.pauseMs, 500, 0, 60_000, 'pauseMs'),
    runForMinutes: boundedInteger(value.runForMinutes, 0, 0, 10_080, 'runForMinutes')
  };
}

export function pendingEosBackfillState(): EosBackfillState {
  return {
    version: EOS_BACKFILL_VERSION,
    status: 'pending',
    tableIndex: 0,
    cursor: 0,
    highWaterMarks: {},
    completedIndexes: [],
    updatedAt: new Date().toISOString()
  };
}

export function completedEosBackfillState(): EosBackfillState {
  return {
    version: EOS_BACKFILL_VERSION,
    status: 'complete',
    tableIndex: EVENT_TABLES.length,
    cursor: 0,
    highWaterMarks: {},
    completedIndexes: EOS_EVENT_INDEXES.map(([tableName, column]) =>
      eosIndexName(tableName, column)
    ),
    updatedAt: new Date().toISOString()
  };
}

export async function ensureEosBackfillState(
  sequelize: Sequelize,
  fallback: EosBackfillState
): Promise<EosBackfillState> {
  return withMetadataTransaction(sequelize, async (transaction, model) => {
    const row = await model.findByPk(
      EOS_BACKFILL_METADATA_KEY,
      lockOptions(sequelize, transaction)
    );
    if (row) return parseState(row.get('value'));
    await model.create(
      { key: EOS_BACKFILL_METADATA_KEY, value: JSON.stringify(fallback) },
      { transaction }
    );
    return fallback;
  });
}

export async function readEosBackfillState(sequelize: Sequelize): Promise<EosBackfillState> {
  const row = await metadataModel(sequelize).findByPk(EOS_BACKFILL_METADATA_KEY);
  if (!row) throw new Error('DBLog EOS backfill state is missing');
  return parseState(row.get('value'));
}

export async function runEosBackfill(
  sequelize: Sequelize,
  options: RunEosBackfillOptions
): Promise<EosBackfillState> {
  if (options.mode === 'off') return readEosBackfillState(sequelize);
  const owner = randomUUID();
  const acquired = await acquireLeaseWithRetry(sequelize, owner, options);
  if (!acquired.acquired) {
    return acquired.state;
  }

  let heartbeatError: Error | undefined;
  const heartbeat =
    sequelize.getDialect() === 'sqlite'
      ? undefined
      : setInterval(() => {
          void refreshLease(sequelize, owner).catch((error: unknown) => {
            heartbeatError = asError(error);
          });
        }, LEASE_REFRESH_MS);
  heartbeat?.unref();

  const deadline =
    options.runForMinutes > 0 ? Date.now() + options.runForMinutes * 60_000 : undefined;
  let batchNumber = 0;
  try {
    let state = await initializeHighWaterMarks(sequelize, owner);
    emit(options, { kind: 'started', state });

    while (state.tableIndex < EVENT_TABLES.length) {
      throwIfHeartbeatFailed(heartbeatError);
      const table = EVENT_TABLES[state.tableIndex];
      if (!table) throw new Error(`DBLog EOS backfill table index is invalid: ${state.tableIndex}`);
      const highWaterMark = state.highWaterMarks[table.name] ?? 0;
      emit(options, { kind: 'table', table: table.name, cursor: state.cursor, highWaterMark });

      while (state.cursor < highWaterMark) {
        throwIfHeartbeatFailed(heartbeatError);
        const pauseReason = requestedPause(options.signal, deadline);
        if (pauseReason) {
          state = await pauseBackfill(sequelize, owner, pauseReason);
          emit(options, { kind: 'paused', reason: pauseReason });
          return state;
        }

        const ids = await selectBatchIDs(
          sequelize,
          table.name,
          state.cursor,
          highWaterMark,
          options.batchSize
        );
        if (ids.length === 0) break;
        const boundary = ids.at(-1);
        if (boundary === undefined) break;

        const batchStartedAt = performance.now();
        state = await sequelize.transaction(async (transaction) => {
          await backfillBatch(
            sequelize,
            table.name,
            table.columns,
            state.cursor,
            boundary,
            transaction
          );
          return updateOwnedState(
            sequelize,
            owner,
            (current) => ({
              ...current,
              status: 'running',
              cursor: boundary,
              updatedAt: new Date().toISOString(),
              error: undefined
            }),
            transaction
          );
        });
        batchNumber += 1;
        emit(options, {
          kind: 'batch',
          table: table.name,
          cursor: state.cursor,
          highWaterMark,
          scannedRows: ids.length,
          batchNumber,
          durationMs: performance.now() - batchStartedAt
        });
        if (options.pauseMs > 0) await abortableDelay(options.pauseMs, options.signal);
      }

      state = await updateOwnedState(sequelize, owner, (current) => ({
        ...current,
        status: current.tableIndex + 1 >= EVENT_TABLES.length ? 'indexing' : 'running',
        tableIndex: current.tableIndex + 1,
        cursor: 0,
        updatedAt: new Date().toISOString()
      }));
    }

    for (const [tableName, column] of EOS_EVENT_INDEXES) {
      throwIfHeartbeatFailed(heartbeatError);
      const pauseReason = requestedPause(options.signal, deadline);
      if (pauseReason) {
        state = await pauseBackfill(sequelize, owner, pauseReason);
        emit(options, { kind: 'paused', reason: pauseReason });
        return state;
      }
      const index = eosIndexName(tableName, column);
      if (state.completedIndexes.includes(index)) continue;
      emit(options, { kind: 'index', index });
      await addEosIndex(sequelize, tableName, column, options.mode === 'background');
      state = await updateOwnedState(sequelize, owner, (current) => ({
        ...current,
        status: 'indexing',
        completedIndexes: [...new Set([...current.completedIndexes, index])],
        updatedAt: new Date().toISOString()
      }));
    }

    state = await updateOwnedState(sequelize, owner, (current) => ({
      ...current,
      status: 'complete',
      lease: undefined,
      error: undefined,
      updatedAt: new Date().toISOString()
    }));
    emit(options, { kind: 'complete' });
    return state;
  } catch (error) {
    if (options.signal?.aborted) {
      const state = await pauseBackfill(sequelize, owner, 'shutdown');
      emit(options, { kind: 'paused', reason: 'shutdown' });
      return state;
    }
    await failBackfill(sequelize, owner, asError(error));
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function initializeHighWaterMarks(
  sequelize: Sequelize,
  owner: string
): Promise<EosBackfillState> {
  const current = await readEosBackfillState(sequelize);
  if (Object.keys(current.highWaterMarks).length > 0) return current;
  const highWaterMarks: Record<string, number> = {};
  for (const table of EVENT_TABLES) {
    const q = (identifier: string): string => quote(sequelize, identifier);
    const rows = (await sequelize.query(
      `SELECT MAX(${q('id')}) AS ${q('maximumID')} FROM ${quoteDbLogTable(sequelize, table.name)}`,
      { type: QueryTypes.SELECT }
    )) as { maximumID?: unknown }[];
    highWaterMarks[table.name] = nonNegativeInteger(rows[0]?.maximumID, 0);
  }
  return updateOwnedState(sequelize, owner, (state) => ({
    ...state,
    status: 'running',
    highWaterMarks,
    updatedAt: new Date().toISOString()
  }));
}

async function selectBatchIDs(
  sequelize: Sequelize,
  tableName: string,
  cursor: number,
  highWaterMark: number,
  batchSize: number
): Promise<number[]> {
  const q = (identifier: string): string => quote(sequelize, identifier);
  const rows = (await sequelize.query(
    `SELECT ${q('id')} AS ${q('id')} FROM ${quoteDbLogTable(
      sequelize,
      tableName
    )} WHERE ${q('id')} > :cursor AND ${q('id')} <= :highWaterMark ORDER BY ${q(
      'id'
    )} ASC LIMIT :batchSize`,
    { replacements: { cursor, highWaterMark, batchSize }, type: QueryTypes.SELECT }
  )) as { id?: unknown }[];
  return rows.map((row) => nonNegativeInteger(row.id, -1)).filter((id) => id >= 0);
}

async function backfillBatch(
  sequelize: Sequelize,
  tableName: string,
  columns: readonly (readonly [legacyColumn: string, eosColumn: string])[],
  cursor: number,
  boundary: number,
  transaction: Transaction
): Promise<void> {
  if (sequelize.getDialect() === 'postgres') {
    await backfillPostgresBatch(sequelize, tableName, columns, cursor, boundary, transaction);
    return;
  }
  const q = (identifier: string): string => quote(sequelize, identifier);
  const eventTable = quoteDbLogTable(sequelize, tableName);
  const playersTable = quoteDbLogTable(sequelize, 'DBLog_Players');
  const playerMatch = (legacyColumn: string): string =>
    `${playersTable}.${q('steamID')} = ${eventTable}.${q(legacyColumn)}`;
  const assignments = columns
    .map(
      ([legacyColumn, eosColumn]) =>
        `${q(eosColumn)} = CASE WHEN ${q(eosColumn)} IS NULL AND ${q(
          legacyColumn
        )} IS NOT NULL THEN (SELECT ${playersTable}.${q('eosID')} FROM ${playersTable} WHERE ${playerMatch(
          legacyColumn
        )}) ELSE ${q(eosColumn)} END`
    )
    .join(', ');
  const hasMapping = columns
    .map(
      ([legacyColumn, eosColumn]) =>
        `(${q(eosColumn)} IS NULL AND ${q(legacyColumn)} IS NOT NULL AND EXISTS (` +
        `SELECT 1 FROM ${playersTable} WHERE ${playerMatch(legacyColumn)} AND ${playersTable}.${q(
          'eosID'
        )} IS NOT NULL))`
    )
    .join(' OR ');
  await sequelize.query(
    `UPDATE ${eventTable} SET ${assignments} WHERE ${q('id')} > :cursor AND ${q(
      'id'
    )} <= :boundary AND (${hasMapping})`,
    { replacements: { cursor, boundary }, transaction }
  );
}

async function backfillPostgresBatch(
  sequelize: Sequelize,
  tableName: string,
  columns: readonly (readonly [legacyColumn: string, eosColumn: string])[],
  cursor: number,
  boundary: number,
  transaction: Transaction
): Promise<void> {
  const q = (identifier: string): string => quote(sequelize, identifier);
  const eventTable = quoteDbLogTable(sequelize, tableName);
  const playersTable = quoteDbLogTable(sequelize, 'DBLog_Players');
  const source = q('sourceEvent');
  const target = q('targetEvent');
  const mapped = q('mappedEOS');
  const playerAliases = columns.map((_, index) => q(`player${index}`));
  const selectedMappings = columns
    .map(([, eosColumn], index) => `${playerAliases[index]}.${q('eosID')} AS ${q(eosColumn)}`)
    .join(', ');
  const joins = columns
    .map(
      ([legacyColumn], index) =>
        `LEFT JOIN ${playersTable} AS ${playerAliases[index]} ON ` +
        `${playerAliases[index]}.${q('steamID')} = ${source}.${q(legacyColumn)} AND ` +
        `${playerAliases[index]}.${q('eosID')} IS NOT NULL`
    )
    .join(' ');
  const assignments = columns
    .map(
      ([, eosColumn]) =>
        `${q(eosColumn)} = COALESCE(${target}.${q(eosColumn)}, ${mapped}.${q(eosColumn)})`
    )
    .join(', ');
  const hasMapping = columns
    .map(
      ([, eosColumn]) =>
        `(${target}.${q(eosColumn)} IS NULL AND ${mapped}.${q(eosColumn)} IS NOT NULL)`
    )
    .join(' OR ');

  await sequelize.query(
    `WITH ${mapped} AS MATERIALIZED (` +
      `SELECT ${source}.${q('id')} AS ${q('id')}, ${selectedMappings} ` +
      `FROM ${eventTable} AS ${source} ${joins} ` +
      `WHERE ${source}.${q('id')} > :cursor AND ${source}.${q('id')} <= :boundary` +
      `) UPDATE ${eventTable} AS ${target} SET ${assignments} FROM ${mapped} ` +
      `WHERE ${target}.${q('id')} = ${mapped}.${q('id')} AND (${hasMapping})`,
    { replacements: { cursor, boundary }, transaction }
  );
}

async function addEosIndex(
  sequelize: Sequelize,
  tableName: string,
  column: string,
  online: boolean
): Promise<void> {
  const indexName = eosIndexName(tableName, column);
  if (sequelize.getDialect() === 'postgres' && online) {
    const validity = await postgresIndexValidity(sequelize, indexName);
    if (validity === true) return;
    if (validity === false) {
      await sequelize.query(`DROP INDEX CONCURRENTLY ${quotePostgresIndex(sequelize, indexName)}`);
    }
    await sequelize.query(
      `CREATE INDEX CONCURRENTLY ${quote(sequelize, indexName)} ON ${quoteDbLogTable(
        sequelize,
        tableName
      )} (${quote(sequelize, column)})`
    );
    return;
  }

  if (await indexExists(sequelize, tableName, indexName, column)) return;
  if (online && ['mysql', 'mariadb'].includes(sequelize.getDialect())) {
    try {
      await sequelize.query(
        `ALTER TABLE ${quoteDbLogTable(sequelize, tableName)} ADD INDEX ${quote(
          sequelize,
          indexName
        )} (${quote(sequelize, column)}), ALGORITHM=INPLACE, LOCK=NONE`
      );
    } catch (error) {
      throw new Error(
        `Could not create ${indexName} online; retry eosBackfill in blocking mode during maintenance`,
        { cause: error }
      );
    }
    return;
  }

  await sequelize.getQueryInterface().addIndex(dbLogTableName(sequelize, tableName), [column], {
    name: indexName
  });
}

async function postgresIndexValidity(
  sequelize: Sequelize,
  indexName: string
): Promise<boolean | undefined> {
  const schema = configuredDbSchema(sequelize);
  const rows = (await sequelize.query(
    `SELECT index_state.indisvalid AS ${quote(sequelize, 'valid')} FROM pg_class index_class ` +
      `JOIN pg_index index_state ON index_state.indexrelid = index_class.oid ` +
      `JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace ` +
      `WHERE index_class.relname = :indexName AND index_namespace.nspname = ${
        schema ? ':schema' : 'current_schema()'
      }`,
    {
      replacements: schema ? { indexName, schema } : { indexName },
      type: QueryTypes.SELECT
    }
  )) as { valid?: unknown }[];
  if (rows.length === 0) return undefined;
  return rows[0]?.valid === true;
}

async function indexExists(
  sequelize: Sequelize,
  tableName: string,
  indexName: string,
  column: string
): Promise<boolean> {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex(dbLogTableName(sequelize, tableName))) as {
    readonly name?: string;
    readonly fields?: readonly { readonly attribute?: string; readonly name?: string }[];
  }[];
  return indexes.some(
    (index) =>
      index.name === indexName ||
      index.fields?.some((field) => (field.attribute ?? field.name) === column)
  );
}

async function acquireLease(
  sequelize: Sequelize,
  owner: string
): Promise<{ readonly acquired: boolean; readonly state: EosBackfillState }> {
  return withMetadataTransaction(sequelize, async (transaction, model) => {
    const row = await requiredStateRow(sequelize, model, transaction);
    const state = parseState(row.get('value'));
    if (state.status === 'complete') return { acquired: false, state };
    if (
      state.lease &&
      state.lease.owner !== owner &&
      Date.parse(state.lease.expiresAt) > Date.now()
    ) {
      return { acquired: false, state };
    }
    const next: EosBackfillState = {
      ...state,
      status: state.tableIndex >= EVENT_TABLES.length ? 'indexing' : 'running',
      lease: lease(owner),
      error: undefined,
      updatedAt: new Date().toISOString()
    };
    await row.update({ value: JSON.stringify(next) }, { transaction });
    return { acquired: true, state: next };
  });
}

async function acquireLeaseWithRetry(
  sequelize: Sequelize,
  owner: string,
  options: RunEosBackfillOptions
): Promise<{ readonly acquired: boolean; readonly state: EosBackfillState }> {
  while (true) {
    const acquired = await acquireLease(sequelize, owner);
    if (acquired.acquired || acquired.state.status === 'complete') return acquired;

    emit(options, {
      kind: 'busy',
      owner: acquired.state.lease?.owner ?? 'unknown',
      expiresAt: acquired.state.lease?.expiresAt ?? 'unknown'
    });
    if (options.mode !== 'background') return acquired;

    const expiresAt = Date.parse(acquired.state.lease?.expiresAt ?? '');
    const waitMs = Number.isFinite(expiresAt)
      ? Math.max(250, Math.min(LEASE_DURATION_MS, expiresAt - Date.now() + 250))
      : 1000;
    await abortableDelay(waitMs, options.signal);
    if (options.signal?.aborted) return acquired;
  }
}

async function refreshLease(sequelize: Sequelize, owner: string): Promise<void> {
  await updateOwnedState(sequelize, owner, (state) => ({
    ...state,
    lease: lease(owner),
    updatedAt: new Date().toISOString()
  }));
}

async function pauseBackfill(
  sequelize: Sequelize,
  owner: string,
  _reason: 'shutdown' | 'time-limit'
): Promise<EosBackfillState> {
  return updateOwnedState(sequelize, owner, (state) => ({
    ...state,
    status: 'paused',
    lease: undefined,
    updatedAt: new Date().toISOString()
  }));
}

async function failBackfill(sequelize: Sequelize, owner: string, error: Error): Promise<void> {
  try {
    await updateOwnedState(sequelize, owner, (state) => ({
      ...state,
      status: 'failed',
      lease: undefined,
      error: error.message.slice(0, 1000),
      updatedAt: new Date().toISOString()
    }));
  } catch {
    // Preserve the original database error when the state update also fails.
  }
}

async function updateOwnedState(
  sequelize: Sequelize,
  owner: string,
  update: (state: EosBackfillState) => EosBackfillState,
  existingTransaction?: Transaction
): Promise<EosBackfillState> {
  const operation = async (transaction: Transaction, model: ModelStatic<Model>) => {
    const row = await requiredStateRow(sequelize, model, transaction);
    const current = parseState(row.get('value'));
    if (current.lease?.owner !== owner) throw new Error('DBLog EOS backfill lease was lost');
    const next = update(current);
    await row.update({ value: JSON.stringify(next) }, { transaction });
    return next;
  };
  if (existingTransaction) return operation(existingTransaction, metadataModel(sequelize));
  return withMetadataTransaction(sequelize, operation);
}

async function requiredStateRow(
  sequelize: Sequelize,
  model: ModelStatic<Model>,
  transaction: Transaction
): Promise<Model> {
  const row = await model.findByPk(EOS_BACKFILL_METADATA_KEY, lockOptions(sequelize, transaction));
  if (!row) throw new Error('DBLog EOS backfill state is missing');
  return row;
}

async function withMetadataTransaction<T>(
  sequelize: Sequelize,
  operation: (transaction: Transaction, model: ModelStatic<Model>) => Promise<T>
): Promise<T> {
  return sequelize.transaction(
    sequelize.getDialect() === 'sqlite' ? { type: Transaction.TYPES.IMMEDIATE } : {},
    (transaction) => operation(transaction, metadataModel(sequelize))
  );
}

function metadataModel(sequelize: Sequelize): ModelStatic<Model> {
  const existing = sequelize.models.DBLog_EosBackfillMetadata;
  if (existing) return existing;
  const schema = configuredDbSchema(sequelize);
  return sequelize.define(
    'DBLog_EosBackfillMetadata',
    {
      key: { type: DataTypes.STRING, primaryKey: true },
      value: { type: DataTypes.TEXT, allowNull: false }
    },
    {
      timestamps: false,
      tableName: 'DBLog_Metadata',
      ...(schema ? { schema } : {})
    }
  );
}

function lockOptions(sequelize: Sequelize, transaction: Transaction) {
  return sequelize.getDialect() === 'sqlite'
    ? { transaction }
    : { transaction, lock: transaction.LOCK.UPDATE };
}

function parseState(value: unknown): EosBackfillState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error('DBLog EOS backfill state is invalid JSON');
  }
  if (!record(parsed) || parsed.version !== EOS_BACKFILL_VERSION) {
    throw new Error('DBLog EOS backfill state has an unsupported version');
  }
  if (
    !['pending', 'running', 'paused', 'indexing', 'complete', 'failed'].includes(
      String(parsed.status)
    )
  ) {
    throw new Error('DBLog EOS backfill state has an invalid status');
  }
  if (!record(parsed.highWaterMarks) || !Array.isArray(parsed.completedIndexes)) {
    throw new Error('DBLog EOS backfill state is incomplete');
  }
  return parsed as unknown as EosBackfillState;
}

function lease(owner: string): NonNullable<EosBackfillState['lease']> {
  return { owner, expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString() };
}

function requestedPause(
  signal: AbortSignal | undefined,
  deadline: number | undefined
): 'shutdown' | 'time-limit' | undefined {
  if (signal?.aborted) return 'shutdown';
  if (deadline !== undefined && Date.now() >= deadline) return 'time-limit';
  return undefined;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => done();
    signal?.addEventListener('abort', onAbort, { once: true });
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

function emit(options: RunEosBackfillOptions, progress: EosBackfillProgress): void {
  try {
    options.onProgress?.(progress);
  } catch {
    // Observability callbacks must not alter migration behavior.
  }
}

function quote(sequelize: Sequelize, identifier: string): string {
  return sequelize.getQueryInterface().quoteIdentifier(identifier);
}

function quotePostgresIndex(sequelize: Sequelize, indexName: string): string {
  const schema = configuredDbSchema(sequelize);
  return schema
    ? `${quote(sequelize, schema)}.${quote(sequelize, indexName)}`
    : quote(sequelize, indexName);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`DBLog.eosBackfill.${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfHeartbeatFailed(error: Error | undefined): void {
  if (error)
    throw new Error(`DBLog EOS backfill lease heartbeat failed: ${error.message}`, {
      cause: error
    });
}
