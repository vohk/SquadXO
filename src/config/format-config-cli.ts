import { formatConfigFile, formatConfigSource } from './config-formatter.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const { check, path } = parseArguments(process.argv.slice(2));
  const config = await loadRuntimeConfig(path);
  const sortPlugins = config.configManagement.sortPlugins;
  if (check) {
    const source = await readFile(path, 'utf8');
    const changed = formatConfigSource(source, { sortPlugins }) !== source;
    process.stdout.write(changed ? `${path} needs formatting.\n` : `${path} is formatted.\n`);
    if (changed) process.exitCode = 1;
    return;
  }
  const result = await formatConfigFile(path, { sortPlugins });
  process.stdout.write(result.changed ? `Formatted ${path}.\n` : `${path} is already formatted.\n`);
}

function parseArguments(arguments_: readonly string[]): {
  readonly check: boolean;
  readonly path: string;
} {
  let check = false;
  let path = 'config.json';
  let pathSet = false;
  for (const argument of arguments_) {
    if (argument === '--check') check = true;
    else if (!pathSet) {
      path = argument;
      pathSet = true;
    } else throw new Error(`Unexpected argument: ${argument}`);
  }
  return { check, path };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
