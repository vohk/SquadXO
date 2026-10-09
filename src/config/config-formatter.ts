import { open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export interface ConfigFormattingOptions {
  readonly sortPlugins?: boolean;
}

export interface ConfigFormatResult {
  readonly changed: boolean;
  readonly path: string;
}

const ROOT_KEYS = ['server', 'layers', 'connectors', 'plugins', 'configManagement'] as const;
const SERVER_KEYS = [
  'id',
  'host',
  'rconPort',
  'rconPassword',
  'serverName',
  'logReaderMode',
  'logDir',
  'sftp',
  'adminLists'
] as const;
const CONFIG_MANAGEMENT_KEYS = ['reorderOnStartup', 'sortPlugins'] as const;
const LAYER_KEYS = ['sources'] as const;
const LAYER_SOURCE_KEYS = ['name', 'url'] as const;
const LEGACY_PLUGIN_KEYS = ['plugin', 'enabled'] as const;
const NATIVE_PLUGIN_KEYS = [
  'type',
  'name',
  'module',
  'source',
  'updates',
  'enabled',
  'connectors',
  'options'
] as const;

export function formatConfigSource(source: string, options: ConfigFormattingOptions = {}): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('config: invalid JSON');
  }
  if (!isRecord(parsed)) throw new Error('config: expected an object');
  return `${JSON.stringify(orderRoot(parsed, options.sortPlugins ?? true), null, 2)}\n`;
}

export async function formatConfigFile(
  path: string,
  options: ConfigFormattingOptions = {}
): Promise<ConfigFormatResult> {
  const configPath = await realpath(resolve(path));
  const file = await open(configPath, 'r');
  let source: string;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error(`Config formatting requires a regular file: ${path}`);
    source = await file.readFile('utf8');
  } finally {
    await file.close();
  }

  const formatted = formatConfigSource(source, options);
  if (formatted === source) return { changed: false, path: configPath };

  const metadata = await stat(configPath);
  const temporaryPath = `${dirname(configPath)}/.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`;
  let temporaryFile;
  try {
    temporaryFile = await open(temporaryPath, 'wx', metadata.mode & 0o777);
    await temporaryFile.writeFile(formatted, 'utf8');
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, configPath);
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { changed: true, path: configPath };
}

function orderRoot(config: Record<string, unknown>, sortPlugins: boolean): Record<string, unknown> {
  const ordered = orderKeys(config, ROOT_KEYS);
  if (isRecord(config.server)) ordered.server = orderKeys(config.server, SERVER_KEYS);
  if (isRecord(config.layers)) {
    ordered.layers = orderKeys(config.layers, LAYER_KEYS);
    if (Array.isArray(config.layers.sources)) {
      (ordered.layers as Record<string, unknown>).sources = config.layers.sources.map((source) =>
        isRecord(source) ? orderKeys(source, LAYER_SOURCE_KEYS) : source
      );
    }
  }
  if (isRecord(config.connectors)) ordered.connectors = orderConnectors(config.connectors);
  if (Array.isArray(config.plugins)) ordered.plugins = orderPlugins(config.plugins, sortPlugins);
  if (isRecord(config.configManagement)) {
    ordered.configManagement = orderKeys(config.configManagement, CONFIG_MANAGEMENT_KEYS);
  }
  return ordered;
}

function orderConnectors(connectors: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(connectors).sort(([left], [right]) => compareNames(left, right))
  );
}

function orderPlugins(plugins: readonly unknown[], sortPlugins: boolean): readonly unknown[] {
  const ordered = plugins.map((plugin) => {
    if (!isRecord(plugin)) return plugin;
    return orderKeys(plugin, plugin.type === 'native' ? NATIVE_PLUGIN_KEYS : LEGACY_PLUGIN_KEYS);
  });
  if (!sortPlugins) return ordered;
  return ordered.sort((left, right) => compareNames(pluginName(left), pluginName(right)));
}

function pluginName(plugin: unknown): string {
  if (!isRecord(plugin)) return '';
  const name = plugin.type === 'native' ? plugin.name : plugin.plugin;
  return typeof name === 'string' ? name : '';
}

function orderKeys(
  value: Record<string, unknown>,
  preferredKeys: readonly string[]
): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  const used = new Set<string>();
  for (const key of preferredKeys) {
    if (!Object.hasOwn(value, key)) continue;
    entries.push([key, value[key]]);
    used.add(key);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!used.has(key)) entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function compareNames(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
