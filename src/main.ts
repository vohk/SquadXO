import { loadRuntimeConfig } from './config/runtime-config.js';
import { formatConfigFile } from './config/config-formatter.js';
import { IntegratedRuntime } from './server/integrated-runtime.js';

interface CliOptions {
  readonly configPath: string;
  readonly durationMs?: number;
  readonly shadow: boolean;
  readonly auditPlugins: boolean;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = await loadRuntimeConfig(options.configPath);
  if (config.configManagement.reorderOnStartup) {
    try {
      const result = await formatConfigFile(options.configPath, {
        sortPlugins: config.configManagement.sortPlugins
      });
      if (result.changed) process.stdout.write(`Reordered configuration file ${result.path}.\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not reorder configuration file: ${detail}\n`);
    }
  }
  const runtime = new IntegratedRuntime(config, {
    loadPlugins: !options.shadow,
    allowMutatingRcon: !options.auditPlugins
  });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());

  await runtime.start();
  if (options.durationMs !== undefined) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.durationMs));
    await stop();
    process.stdout.write(`${JSON.stringify(runtime.health(), null, 2)}\n`);
    if (process.env.SQUADJS_DEBUG_HANDLES === '1') {
      process.stdout.write(
        `${JSON.stringify({ activeResources: process.getActiveResourcesInfo().sort() }, null, 2)}\n`
      );
    }
    return;
  }

  process.stdout.write('SquadXO runtime started. Press Ctrl+C to stop.\n');
  while (!stopping) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  let configPath = 'config.json';
  let durationMs: number | undefined;
  let shadow = false;
  let auditPlugins = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--config') {
      const value = arguments_[index + 1];
      if (!value) throw new Error('--config requires a path');
      configPath = value;
      index += 1;
    } else if (argument === '--duration-ms') {
      const value = Number(arguments_[index + 1]);
      if (!Number.isFinite(value) || value < 1000) {
        throw new Error('--duration-ms requires a number of at least 1000');
      }
      durationMs = value;
      index += 1;
    } else if (argument === '--shadow') {
      shadow = true;
    } else if (argument === '--audit-plugins') {
      auditPlugins = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (shadow && auditPlugins) throw new Error('--shadow and --audit-plugins cannot be combined');
  return {
    configPath,
    shadow,
    auditPlugins,
    ...(durationMs === undefined ? {} : { durationMs })
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`SquadXO runtime failed: ${formatError(error)}\n`);
  process.exitCode = 1;
});

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map((entry: unknown) => formatError(entry));
    return [error.message, ...details.map((detail: string) => `  - ${detail}`)].join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}
