import { Sequelize } from 'sequelize';

import { loadRuntimeConfig, type RuntimeLegacyPluginConfig } from '../config/runtime-config.js';
import {
  parseEosBackfillOptions,
  runEosBackfill,
  type EosBackfillMode,
  type EosBackfillProgress
} from './eos-backfill.js';
import { migrateDbLog } from './migrations.js';

interface CliOptions {
  readonly configPath: string;
  readonly connector?: string;
  readonly mode: Exclude<EosBackfillMode, 'off'>;
  readonly batchSize: number;
  readonly pauseMs: number;
  readonly runForMinutes: number;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = await loadRuntimeConfig(options.configPath);
  const dbLog = config.plugins.find(
    (plugin): plugin is RuntimeLegacyPluginConfig =>
      'plugin' in plugin && plugin.plugin === 'DBLog' && plugin.enabled
  );
  const connectorName = options.connector ?? dbLog?.database;
  if (typeof connectorName !== 'string' || !connectorName) {
    throw new Error('No enabled DBLog database connector was found; pass --connector <name>');
  }
  const connector = config.connectors[connectorName];
  if (typeof connector !== 'string' && !record(connector)) {
    throw new Error(`Sequelize connector ${connectorName} is missing or invalid`);
  }

  const sequelize =
    typeof connector === 'string'
      ? new Sequelize(connector, { logging: false })
      : new Sequelize({ ...connector, logging: false } as never);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await sequelize.authenticate();
    process.stdout.write(`[DBLog] Connected through ${connectorName}; checking schema.\n`);
    const version = await migrateDbLog(sequelize, (change) => {
      process.stdout.write(
        change.kind === 'migrate'
          ? `[DBLog] Structural migration to version ${change.toVersion} in progress.\n`
          : `[DBLog] Creating schema version ${change.toVersion}.\n`
      );
    });
    process.stdout.write(`[DBLog] Database schema ready at version ${version}.\n`);

    const state = await runEosBackfill(sequelize, {
      mode: options.mode,
      batchSize: options.batchSize,
      pauseMs: options.pauseMs,
      runForMinutes: options.runForMinutes,
      signal: controller.signal,
      onProgress: reportProgress
    });
    process.stdout.write(
      `[DBLog] EOS backfill stopped with status ${state.status}, table index ` +
        `${state.tableIndex}, cursor ${state.cursor}.\n`
    );
    if (!['complete', 'paused'].includes(state.status)) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await sequelize.close();
  }
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  let configPath = 'config.json';
  let connector: string | undefined;
  let mode: Exclude<EosBackfillMode, 'off'> = 'background';
  let batchSize = 5000;
  let pauseMs = 500;
  let runForMinutes = 0;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === '--config' && value) configPath = value;
    else if (argument === '--connector' && value) connector = value;
    else if (argument === '--mode' && ['background', 'blocking'].includes(value ?? '')) {
      mode = value as Exclude<EosBackfillMode, 'off'>;
    } else if (argument === '--batch-size' && value) batchSize = Number(value);
    else if (argument === '--pause-ms' && value) pauseMs = Number(value);
    else if (argument === '--run-for-minutes' && value) runForMinutes = Number(value);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }

  const parsed = parseEosBackfillOptions({ mode, batchSize, pauseMs, runForMinutes });
  return {
    configPath,
    mode,
    batchSize: parsed.batchSize,
    pauseMs: parsed.pauseMs,
    runForMinutes: parsed.runForMinutes,
    ...(connector ? { connector } : {})
  };
}

function reportProgress(progress: EosBackfillProgress): void {
  if (progress.kind === 'batch') {
    const percent =
      progress.highWaterMark === 0
        ? 100
        : Math.min(100, (progress.cursor / progress.highWaterMark) * 100);
    const rowsPerSecond =
      progress.durationMs <= 0 ? 0 : (progress.scannedRows / progress.durationMs) * 1000;
    process.stdout.write(
      `[DBLog] ${progress.table} ${progress.cursor}/${progress.highWaterMark} ` +
        `(${percent.toFixed(2)}%): ${progress.durationMs.toFixed(0)} ms, ` +
        `${rowsPerSecond.toFixed(0)} rows/s.\n`
    );
  } else if (progress.kind === 'started') {
    process.stdout.write('[DBLog] Historical EOS backfill started.\n');
  } else if (progress.kind === 'table') {
    process.stdout.write(
      `[DBLog] Scanning ${progress.table} from ${progress.cursor} to ${progress.highWaterMark}.\n`
    );
  } else if (progress.kind === 'index') {
    process.stdout.write(`[DBLog] Creating deferred EOS index ${progress.index}.\n`);
  } else if (progress.kind === 'busy') {
    process.stdout.write(
      `[DBLog] Lease held by ${progress.owner} until ${progress.expiresAt}; waiting.\n`
    );
  } else if (progress.kind === 'paused') {
    process.stdout.write(`[DBLog] Backfill paused (${progress.reason}).\n`);
  } else {
    process.stdout.write('[DBLog] Historical EOS backfill and index creation complete.\n');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `DBLog EOS backfill failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
