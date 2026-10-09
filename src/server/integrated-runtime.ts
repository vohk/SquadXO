import { join } from 'node:path';
import { LegacyServerHost, type PluginFailure } from '../compatibility/legacy-server-facade.js';
import { loadAdminLists } from '../compatibility/admin-lists.js';
import { LegacyLayerCatalog } from '../compatibility/legacy-layer-catalog.js';
import { createCoreDbLogAdapter } from '../compatibility/core-db-log-adapter.js';
import { createLegacyStateRefreshHooks } from '../compatibility/state-refresh-hooks.js';
import { LegacyPluginLoader } from '../compatibility/legacy-plugin-loader.js';
import {
  createLegacyPluginPlan,
  type ConnectorRequirement,
  type LegacyPluginPlan
} from '../compatibility/legacy-plugin-plan.js';
import {
  type RuntimeConfig,
  type RuntimeLegacyPluginConfig,
  type RuntimeNativePluginConfig
} from '../config/runtime-config.js';
import { LegacyConnectorManager } from '../connectors/legacy-connector-manager.js';
import { Sequelize } from 'sequelize';
import { DbLog } from '../database/db-log.js';
import { parseEosBackfillOptions, type EosBackfillProgress } from '../database/eos-backfill.js';
import { DbLogEventBridge, resolvedMatchMetadata } from '../database/event-bridge.js';
import { samplePlayerCount } from '../database/player-count-sampler.js';
import { ServerState } from '../domain/server-state.js';
import { LocalTailReader } from '../logs/local-tail-reader.js';
import { SquadLogParser } from '../logs/parser.js';
import type { LogReader } from '../logs/reader.js';
import { SftpLogReader } from '../logs/sftp-reader.js';
import {
  SquadRconClient,
  type RconConnectionLostEvent,
  type RconReconnectedEvent
} from '../rcon/client.js';
import {
  createNativePluginPlan,
  mountNativePlugin,
  type NativePluginPlan
} from '../plugins/loader.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { NativePluginUpdater, type NativePluginUpdateHealth } from '../plugins/updater.js';
import { OrderedStateDispatcher, ServerStateReducer } from './state-reducer.js';
import { StateRefresher } from './state-refresher.js';
import { startRconChatBridge } from './rcon-chat-bridge.js';

export interface RuntimeHealth {
  readonly rconState: string;
  readonly rconQueueDepth: number;
  readonly lastLogLineAt?: Date;
  readonly logPollingLatencyMs?: number;
  readonly parserWarningCount: number;
  readonly playerCount: number;
  readonly correlationSize: number;
  readonly pluginErrorCount: number;
  readonly logErrorCount: number;
  readonly loadedPlugins: readonly string[];
  readonly skippedPlugins: Readonly<Record<string, string>>;
  readonly pluginUpdates: Readonly<Record<string, NativePluginUpdateHealth>>;
  readonly dbPendingWrites: number;
  readonly dbWriteHighWaterMark: number;
  readonly dbRejectedWrites: number;
  readonly dbPlayerUpserts: number;
  readonly dbPlayerUpsertSkips: number;
  readonly dbErrorCount: number;
  readonly refresh: Readonly<
    Record<string, { readonly lastSucceededAt?: Date; readonly failures: number }>
  >;
}

export type RuntimeLifecycleLogger = (
  level: 'info' | 'error',
  scope: string,
  message: string
) => void;

export class IntegratedRuntime {
  readonly state = new ServerState();
  readonly parser = new SquadLogParser();
  readonly rcon: SquadRconClient;
  readonly events: LegacyServerHost;
  readonly #dispatcher: OrderedStateDispatcher;
  readonly #reader: LogReader;
  readonly #refresher: StateRefresher;
  readonly #loadPlugins: boolean;
  readonly #lifecycleLogger: RuntimeLifecycleLogger;
  readonly #nativePluginUpdater: NativePluginUpdater;
  readonly #connectorManager = new LegacyConnectorManager();
  readonly #legacyLayers: LegacyLayerCatalog;
  #pluginLoader: LegacyPluginLoader | undefined;
  #nativePluginRuntime: PluginRuntime | undefined;
  #loadedPlugins: string[] = [];
  #skippedPlugins: Readonly<Record<string, string>> = {};
  #dbLog: DbLog | undefined;
  #dbBridge: DbLogEventBridge | undefined;
  #dbLogAdapter: object | undefined;
  #dbErrorCount = 0;
  #pluginErrorCount = 0;
  #logErrorCount = 0;
  #started = false;
  #stopPromise: Promise<void> | undefined;
  #stopRconChatBridge: (() => void) | undefined;

  constructor(
    readonly config: RuntimeConfig,
    options: {
      readonly loadPlugins?: boolean;
      readonly allowMutatingRcon?: boolean;
      readonly nativePluginUpdater?: NativePluginUpdater;
      readonly lifecycleLogger?: RuntimeLifecycleLogger;
    } = {}
  ) {
    this.#loadPlugins = options.loadPlugins ?? true;
    this.#lifecycleLogger = options.lifecycleLogger ?? writeLifecycleLog;
    this.#legacyLayers = new LegacyLayerCatalog(
      config.layers ? { sources: config.layers.sources } : {}
    );
    this.#nativePluginUpdater =
      options.nativePluginUpdater ??
      new NativePluginUpdater({
        logger: (plugin, level, message) => {
          const stream = level === 'info' ? process.stdout : process.stderr;
          stream.write(`[PluginUpdater:${plugin}][${level}] ${message}\n`);
        }
      });
    this.rcon = new SquadRconClient({
      host: config.server.host,
      port: config.server.rconPort,
      password: config.server.rconPassword,
      ...(options.allowMutatingRcon === false ? { commandAllowed: isAuditSafeRconCommand } : {})
    });
    this.rcon.on('connectionLost', (event: RconConnectionLostEvent) => {
      this.#lifecycleLogger(
        'error',
        'RCON',
        `Connection to ${config.server.host}:${config.server.rconPort} lost (${event.error.message}); reconnecting in the background.`
      );
    });
    this.rcon.on('reconnected', (event: RconReconnectedEvent) => {
      const attemptLabel = event.attempts === 1 ? 'attempt' : 'attempts';
      this.#lifecycleLogger(
        'info',
        'RCON',
        `Reconnected to ${config.server.host}:${config.server.rconPort} after ${formatDuration(event.durationMs)} (${event.attempts} ${attemptLabel}).`
      );
    });
    this.events = new LegacyServerHost({
      state: this.state,
      rcon: this.rcon,
      onPluginFailure: (failure) => this.#onPluginFailure(failure),
      operations: {
        refreshPlayers: () => this.#refresher.refreshPlayers(),
        refreshSquads: () => this.#refresher.refreshSquads(),
        refreshAdmins: () => this.#refreshAdmins(false)
      }
    });
    this.#dispatcher = new OrderedStateDispatcher(new ServerStateReducer(this.state));
    this.#reader = createReader(config, () => {
      this.#logErrorCount += 1;
    });
    this.#refresher = new StateRefresher(
      this.state,
      this.rcon,
      {},
      createLegacyStateRefreshHooks(this.events, this.#legacyLayers)
    );
    this.#refresher.scheduler.add('dbPlayerCount', 30_000, async () => {
      const dbLog = this.#dbLog;
      if (!dbLog) return;
      await samplePlayerCount(dbLog, this.state.snapshot().serverInfo);
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#stopPromise) await this.#stopPromise;
    try {
      const plans = this.#loadPlugins ? await this.#planPlugins() : undefined;
      if (plans) {
        await Promise.all([this.#refreshAdmins(true), this.#legacyLayers.prepare()]);
      }
      await this.rcon.connect();
      this.#stopRconChatBridge = startRconChatBridge(this.rcon, this.state, this.events, {
        refreshPlayers: () => this.#refresher.refreshPlayers(),
        onMalformedMessage: () => {
          this.#logErrorCount += 1;
        },
        onError: (error) => {
          this.#logErrorCount += 1;
          this.#lifecycleLogger('error', 'RCONBridge', error.message);
        }
      });
      await this.#refresher.initialize();
      if (plans) await this.#startPlugins(plans.legacy, plans.native);
      this.#refresher.start();
      await this.#reader.start((line) => this.#handleLogLine(line));
      this.#started = true;
      if (plans) {
        await this.#nativePluginUpdater.markStartupHealthy();
        this.#nativePluginUpdater.start();
      }
    } catch (error) {
      let rollbackError: unknown;
      try {
        await this.#nativePluginUpdater.rollbackStartup(error);
      } catch (caught) {
        rollbackError = caught;
      }
      const cleanupErrors = await this.#shutdownComponents();
      if (rollbackError) cleanupErrors.push(rollbackError);
      this.#started = false;
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'Runtime startup failed and one or more resources also failed to close'
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (!this.#started) return;
    this.#started = false;
    const stopping = (async () => {
      const errors = await this.#shutdownComponents();
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more runtime resources failed to stop');
      }
    })();
    this.#stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopPromise === stopping) this.#stopPromise = undefined;
    }
  }

  health(): RuntimeHealth {
    const logHealth = this.#reader.health();
    const parser = this.parser.statistics();
    return {
      rconState: this.rcon.state,
      rconQueueDepth: this.rcon.queueDepth,
      ...(logHealth.lastLineAt ? { lastLogLineAt: logHealth.lastLineAt } : {}),
      ...(logHealth.pollingLatencyMs === undefined
        ? {}
        : { logPollingLatencyMs: logHealth.pollingLatencyMs }),
      parserWarningCount: parser.warningCount,
      playerCount: this.state.snapshot().players.length,
      correlationSize: parser.correlationSize,
      pluginErrorCount: this.#pluginErrorCount,
      logErrorCount: this.#logErrorCount,
      loadedPlugins: [...this.#loadedPlugins],
      skippedPlugins: { ...this.#skippedPlugins },
      pluginUpdates: this.#nativePluginUpdater.health(),
      dbPendingWrites: this.#dbLog?.pendingWrites ?? 0,
      dbWriteHighWaterMark: this.#dbLog?.writeQueueHighWaterMark ?? 0,
      dbRejectedWrites: this.#dbLog?.rejectedWrites ?? 0,
      dbPlayerUpserts: this.#dbLog?.playerUpserts ?? 0,
      dbPlayerUpsertSkips: this.#dbLog?.playerUpsertSkips ?? 0,
      dbErrorCount: this.#dbErrorCount,
      refresh: Object.fromEntries(
        ['players', 'squads', 'layers', 'serverInfo', 'dbPlayerCount'].map((name) => {
          const health = this.#refresher.scheduler.health(name);
          return [
            name,
            {
              ...(health?.lastSucceededAt ? { lastSucceededAt: health.lastSucceededAt } : {}),
              failures: health?.failureCount ?? 0
            }
          ];
        })
      )
    };
  }

  #onPluginFailure(failure: PluginFailure): void {
    this.#pluginErrorCount += 1;
    const event = failure.event ? ` while handling ${failure.event}` : '';
    this.#lifecycleLogger(
      'error',
      `Plugin:${failure.plugin}`,
      `Callback failed${event}: ${failure.error.message}`
    );
  }

  async #handleLogLine(line: string): Promise<void> {
    this.events.emit('RAW_LOG_LINE', line);
    for (const parsed of this.parser.parseLine(line)) {
      if (parsed.name === 'JOIN_SUCCEEDED') await this.#refresher.refreshPlayers();
      for (const reduced of this.#dispatcher.process(parsed)) {
        let dbLayer: Readonly<Record<string, unknown>> | undefined;
        if (reduced.name === 'NEW_GAME') {
          await this.#refreshAdmins(false);
          const classname = reduced.data.layerClassname;
          const mapClassname = reduced.data.mapClassname;
          const time = reduced.data.time;
          if (typeof classname === 'string' && time instanceof Date) {
            dbLayer = await this.#legacyLayers.byClassname(
              classname,
              typeof mapClassname === 'string' ? mapClassname : classname
            );
            this.events.recordLegacyLayer(dbLayer, time);
          }
        }
        this.#dbBridge?.handle(reduced, dbLayer ? { layer: dbLayer } : {});
        this.events.publish(reduced);
      }
    }
  }

  async #refreshAdmins(initial: boolean): Promise<void> {
    const sources = this.config.server.adminLists ?? [];
    const result = await loadAdminLists(sources);
    for (const error of result.errors) {
      process.stderr.write(`[AdminLists] ${formatLogDetails(error)}\n`);
    }
    if (sources.length > 0 && result.loadedSources === 0) {
      if (initial) {
        throw new AggregateError(result.errors, 'Every configured admin list failed to load');
      }
      process.stderr.write('[AdminLists] Retaining the last known-good admin permissions.\n');
      return;
    }
    this.events.replaceAdmins(result.admins);
  }

  async #planPlugins(): Promise<{ legacy: LegacyPluginPlan; native: NativePluginPlan }> {
    const legacyConfigs = this.config.plugins.filter(isLegacyPluginConfig);
    const nativeConfigs = this.config.plugins.filter(isNativePluginConfig);
    const resolvedNativeConfigs = await this.#nativePluginUpdater.resolve(nativeConfigs);
    const [legacy, native] = await Promise.all([
      createLegacyPluginPlan(legacyConfigs),
      createNativePluginPlan(resolvedNativeConfigs)
    ]);
    const legacyNames = new Set(legacy.plugins.map((plugin) => plugin.name));
    const duplicateName = native.plugins.find((plugin) => legacyNames.has(plugin.name))?.name;
    if (duplicateName) {
      throw new Error(`Plugin name is configured as both legacy and native: ${duplicateName}`);
    }
    validateConnectorRequirements([...legacy.connectors, ...native.connectors]);
    return { legacy, native };
  }

  async #startPlugins(legacy: LegacyPluginPlan, native: NativePluginPlan): Promise<void> {
    await this.#connectorManager.initialize(
      mergeConnectorRequirements([...legacy.connectors, ...native.connectors]),
      this.config.connectors
    );
    await this.#startDbLog();
    const loader = new LegacyPluginLoader({
      host: this.events,
      connectors: this.#connectorManager.registry,
      serverOptions: this.config.server
    });
    this.#pluginLoader = loader;
    this.#skippedPlugins = legacy.skipped;
    await loader.mountAll(
      legacy.plugins.map((planned) => ({
        PluginClass: planned.PluginClass,
        rawOptions: planned.config
      }))
    );
    this.#loadedPlugins.push(...legacy.plugins.map((planned) => planned.name));
    const nativeRuntime = new PluginRuntime({
      state: this.state,
      rcon: this.rcon,
      connectors: this.#connectorManager.registry,
      events: this.events,
      logs: this.#reader,
      server: {
        id: this.config.server.id,
        ...(typeof this.config.server.serverName === 'string'
          ? { name: this.config.server.serverName }
          : {})
      },
      onFailure: (failure) => this.#onPluginFailure(failure),
      logger: (plugin, level, message, details) => {
        const suffix = details === undefined ? '' : ` ${formatLogDetails(details)}`;
        process.stderr.write(`[NativePlugin:${plugin}][${level}] ${message}${suffix}\n`);
      }
    });
    this.#nativePluginRuntime = nativeRuntime;
    for (const planned of native.plugins) {
      await mountNativePlugin(nativeRuntime, planned);
      this.#loadedPlugins.push(planned.name);
    }
    this.#nativePluginUpdater.bind(nativeRuntime, native);
  }

  async #startDbLog(): Promise<void> {
    const config = this.config.plugins
      .filter(isLegacyPluginConfig)
      .find((plugin) => plugin.enabled && plugin.plugin === 'DBLog');
    if (!config) return;
    const connectorName = config.database;
    if (typeof connectorName !== 'string') throw new Error('DBLog database connector is missing');
    const sequelize = this.#connectorManager.registry.get(connectorName);
    if (!(sequelize instanceof Sequelize)) {
      throw new Error(`DBLog connector ${connectorName} is not a Sequelize connection`);
    }
    const configuredName = this.config.server.serverName;
    const backfillOptions = parseEosBackfillOptions(config.eosBackfill);
    const dbLog = new DbLog(sequelize, {
      serverID:
        typeof config.overrideServerID === 'number'
          ? config.overrideServerID
          : this.config.server.id,
      serverName:
        typeof configuredName === 'string'
          ? configuredName
          : `SquadXO Server ${this.config.server.id}`,
      onWriteError: () => {
        this.#dbErrorCount += 1;
      },
      resolveMatchMetadata: async ({ mapClassname, layerClassname }) =>
        resolvedMatchMetadata(
          layerClassname
            ? await this.#legacyLayers.byClassname(layerClassname, mapClassname)
            : undefined
        ),
      onSchemaChange: (change) => {
        if (change.kind === 'migrate') {
          process.stdout.write(
            `[DBLog] Legacy database schema detected; migration to version ${change.toVersion} in progress...\n`
          );
        } else {
          process.stdout.write(
            `[DBLog] Empty database detected; creating schema version ${change.toVersion}...\n`
          );
        }
      }
    });
    process.stdout.write('[DBLog] Checking database schema...\n');
    const schemaVersion = await dbLog.initialize();
    process.stdout.write(`[DBLog] Database schema ready at version ${schemaVersion}.\n`);
    this.#dbLog = dbLog;
    if (backfillOptions.mode !== 'off') {
      const run = dbLog.startEosBackfill(backfillOptions, (progress) =>
        this.#reportEosBackfillProgress(progress)
      );
      if (backfillOptions.mode === 'blocking') {
        const state = await run;
        if (state.status !== 'complete') {
          throw new Error(`DBLog blocking EOS backfill stopped with status ${state.status}`);
        }
      } else {
        void run.catch((error: unknown) => {
          this.#dbErrorCount += 1;
          process.stderr.write(
            `[DBLog] Historical EOS backfill failed: ${formatLogDetails(error)}\n`
          );
        });
      }
    } else {
      process.stdout.write(
        '[DBLog] Historical EOS backfill is disabled; new records will still include EOS IDs.\n'
      );
    }
    const adapter = await createCoreDbLogAdapter(dbLog, sequelize, config);
    this.events.registerPlugin(adapter);
    this.#dbLogAdapter = adapter;
    this.#dbBridge = new DbLogEventBridge(dbLog, () => {
      this.#dbErrorCount += 1;
    });
  }

  #reportEosBackfillProgress(progress: EosBackfillProgress): void {
    if (progress.kind === 'batch') {
      if (progress.batchNumber % 100 !== 0 && progress.cursor < progress.highWaterMark) return;
      const percent =
        progress.highWaterMark === 0
          ? 100
          : Math.min(100, (progress.cursor / progress.highWaterMark) * 100);
      const rowsPerSecond =
        progress.durationMs <= 0 ? 0 : (progress.scannedRows / progress.durationMs) * 1000;
      process.stdout.write(
        `[DBLog] EOS backfill ${progress.table}: ${progress.cursor}/${progress.highWaterMark} ` +
          `(${percent.toFixed(1)}%, ${progress.durationMs.toFixed(0)} ms batch, ` +
          `${rowsPerSecond.toFixed(0)} rows/s).\n`
      );
      return;
    }
    if (progress.kind === 'started') {
      process.stdout.write('[DBLog] Historical EOS backfill started.\n');
    } else if (progress.kind === 'table') {
      process.stdout.write(
        `[DBLog] EOS backfill scanning ${progress.table} from ID ${progress.cursor} to ${progress.highWaterMark}.\n`
      );
    } else if (progress.kind === 'index') {
      process.stdout.write(`[DBLog] Creating deferred EOS index ${progress.index}.\n`);
    } else if (progress.kind === 'complete') {
      process.stdout.write('[DBLog] Historical EOS backfill and index creation complete.\n');
    } else if (progress.kind === 'paused') {
      process.stdout.write(`[DBLog] Historical EOS backfill paused (${progress.reason}).\n`);
    } else {
      process.stdout.write(
        `[DBLog] Historical EOS backfill is already leased by ${progress.owner} until ${progress.expiresAt}.\n`
      );
    }
  }

  async #shutdownComponents(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    await attempt(() => this.#reader.stop());
    await attempt(() => this.#refresher.stop());
    await attempt(() => this.#stopRconChatBridge?.());
    await attempt(() => this.#nativePluginUpdater.stop());
    await attempt(async () => this.#nativePluginRuntime?.stop());
    await attempt(async () => this.#pluginLoader?.stop());
    await attempt(() => this.events.drain());
    await attempt(async () => this.#dbLog?.stop());
    if (this.#dbLogAdapter) {
      await attempt(() => this.events.unregisterPlugin(this.#dbLogAdapter as object));
    }
    await attempt(() => this.#connectorManager.stop());
    await attempt(() => this.rcon.stop());

    this.#pluginLoader = undefined;
    this.#nativePluginRuntime = undefined;
    this.#stopRconChatBridge = undefined;
    this.#dbLog = undefined;
    this.#dbBridge = undefined;
    this.#dbLogAdapter = undefined;
    this.#loadedPlugins = [];
    this.#skippedPlugins = {};
    return errors;
  }
}

function writeLifecycleLog(level: 'info' | 'error', scope: string, message: string): void {
  const stream = level === 'info' ? process.stdout : process.stderr;
  stream.write(`[${scope}] ${message}\n`);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

const AUDIT_SAFE_RCON_COMMANDS = new Set([
  'ListPlayers',
  'ListSquads',
  'ShowCurrentMap',
  'ShowNextMap',
  'ShowServerInfo'
]);

function isAuditSafeRconCommand(command: string): boolean {
  return AUDIT_SAFE_RCON_COMMANDS.has(command.trim().split(/\s+/, 1)[0] ?? '');
}

function createReader(config: RuntimeConfig, onError: (error: Error) => void): LogReader {
  if (config.server.logReaderMode === 'sftp') {
    const sftp = config.server.sftp;
    if (!sftp) throw new Error('config.server.sftp: required for SFTP reader');
    return new SftpLogReader({ ...sftp, logDir: config.server.logDir, onError });
  }
  return new LocalTailReader({
    path: join(config.server.logDir, 'SquadGame.log'),
    startAt: 'end',
    onError
  });
}

function isLegacyPluginConfig(
  plugin: RuntimeConfig['plugins'][number]
): plugin is RuntimeLegacyPluginConfig {
  return plugin.type !== 'native';
}

function isNativePluginConfig(
  plugin: RuntimeConfig['plugins'][number]
): plugin is RuntimeNativePluginConfig {
  return plugin.type === 'native';
}

function validateConnectorRequirements(requirements: readonly ConnectorRequirement[]): void {
  mergeConnectorRequirements(requirements);
}

function mergeConnectorRequirements(
  requirements: readonly ConnectorRequirement[]
): ConnectorRequirement[] {
  const byName = new Map<string, ConnectorRequirement>();
  for (const requirement of requirements) {
    const existing = byName.get(requirement.name);
    if (existing && existing.type !== requirement.type) {
      throw new Error(
        `Connector ${requirement.name} is requested as both ${existing.type} and ${requirement.type}`
      );
    }
    byName.set(requirement.name, requirement);
  }
  return [...byName.values()];
}

function formatLogDetails(details: unknown): string {
  if (details instanceof Error) return details.message;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}
