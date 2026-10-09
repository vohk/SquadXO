import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseAdminListSources, type AdminListSource } from '../compatibility/admin-lists.js';

export interface RuntimeLegacyPluginConfig extends Record<string, unknown> {
  readonly type?: 'legacy';
  readonly module?: string;
  readonly modulePath?: string;
  readonly plugin: string;
  readonly enabled: boolean;
}

export interface RuntimeNativePluginSource {
  readonly provider: 'github';
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
}

export interface RuntimeNativePluginUpdates {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly apply: 'hot' | 'restart';
}

interface RuntimeNativePluginBase extends Record<string, unknown> {
  readonly type: 'native';
  readonly name: string;
  readonly enabled: boolean;
  readonly options: Readonly<Record<string, unknown>>;
  readonly connectors: Readonly<Record<string, string>>;
}

export interface RuntimeLocalNativePluginConfig extends RuntimeNativePluginBase {
  readonly module: string;
  readonly modulePath: string;
}

export interface RuntimeManagedNativePluginConfig extends RuntimeNativePluginBase {
  readonly source: RuntimeNativePluginSource;
  readonly updates: RuntimeNativePluginUpdates;
  readonly storagePath: string;
}

export type RuntimeNativePluginConfig =
  RuntimeLocalNativePluginConfig | RuntimeManagedNativePluginConfig;

export type RuntimeResolvedNativePluginConfig = RuntimeLocalNativePluginConfig;

export type RuntimePluginConfig = RuntimeLegacyPluginConfig | RuntimeNativePluginConfig;

export interface RuntimeConfigManagement {
  readonly reorderOnStartup: boolean;
  readonly sortPlugins: boolean;
}

export interface RuntimeLayerSource {
  readonly name: string;
  readonly url: string;
}

export interface RuntimeLayerConfig {
  readonly sources: readonly RuntimeLayerSource[];
}

export interface RuntimeConfig {
  readonly server: Readonly<Record<string, unknown>> & {
    readonly id: number;
    readonly host: string;
    readonly rconPort: number;
    readonly rconPassword: string;
    readonly logReaderMode: 'tail' | 'local' | 'sftp';
    readonly logDir: string;
    readonly adminLists?: readonly AdminListSource[];
    readonly sftp?: {
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly password: string;
    };
  };
  readonly layers?: RuntimeLayerConfig;
  readonly connectors: Readonly<Record<string, unknown>>;
  readonly plugins: readonly RuntimePluginConfig[];
  readonly configManagement: RuntimeConfigManagement;
}

export async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
  const configPath = resolve(path);
  const source = await readFile(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('config: invalid JSON');
  }
  if (!record(parsed)) throw new Error('config: expected an object');
  const server = requiredRecord(parsed, 'server', 'config.server');
  const mode = requiredString(server, 'logReaderMode', 'config.server.logReaderMode');
  if (!['tail', 'local', 'sftp'].includes(mode)) {
    throw new Error('config.server.logReaderMode: expected tail, local, or sftp');
  }
  const rconPassword =
    process.env.SQUADJS_RCON_PASSWORD ??
    requiredString(server, 'rconPassword', 'config.server.rconPassword');
  const sftpConfig =
    mode === 'sftp' ? requiredRecord(server, 'sftp', 'config.server.sftp') : undefined;
  const pluginsValue = parsed.plugins ?? [];
  if (!Array.isArray(pluginsValue)) throw new Error('config.plugins: expected an array');
  const plugins = pluginsValue.map((plugin, index) => {
    if (!record(plugin)) throw new Error(`config.plugins[${index}]: expected an object`);
    const pluginPath = `config.plugins[${index}]`;
    if (plugin.type === 'native') {
      const name = requiredString(plugin, 'name', `${pluginPath}.name`);
      const options =
        plugin.options === undefined
          ? {}
          : requiredRecord(plugin, 'options', `${pluginPath}.options`);
      const connectorValues =
        plugin.connectors === undefined
          ? {}
          : requiredRecord(plugin, 'connectors', `${pluginPath}.connectors`);
      const connectors = Object.fromEntries(
        Object.entries(connectorValues).map(([alias, value]) => {
          if (typeof value !== 'string' || !value) {
            throw new Error(`${pluginPath}.connectors.${alias}: expected a non-empty string`);
          }
          return [alias, value];
        })
      );
      const base = {
        ...plugin,
        type: 'native' as const,
        name,
        enabled: requiredBoolean(plugin, 'enabled', `${pluginPath}.enabled`),
        options,
        connectors
      };
      if (plugin.source !== undefined) {
        if (plugin.module !== undefined) {
          throw new Error(`${pluginPath}: module and source cannot both be configured`);
        }
        validateManagedPluginName(name, `${pluginPath}.name`);
        const source = parseNativePluginSource(plugin.source, `${pluginPath}.source`);
        const updates = parseNativePluginUpdates(plugin.updates, `${pluginPath}.updates`);
        return {
          ...base,
          source,
          updates,
          storagePath: resolve('data/native-plugins', name)
        };
      }
      if (plugin.updates !== undefined) {
        throw new Error(`${pluginPath}.updates: requires a managed source`);
      }
      const module = requiredString(plugin, 'module', `${pluginPath}.module`);
      return {
        ...base,
        module,
        modulePath: resolve(dirname(configPath), module)
      };
    }
    if (plugin.type !== undefined && plugin.type !== 'legacy') {
      throw new Error(`${pluginPath}.type: expected legacy or native`);
    }
    return {
      ...plugin,
      ...(plugin.type === 'legacy' ? { type: 'legacy' as const } : {}),
      ...(plugin.module === undefined
        ? {}
        : {
            module: requiredString(plugin, 'module', `${pluginPath}.module`),
            modulePath: resolve(
              dirname(configPath),
              requiredString(plugin, 'module', `${pluginPath}.module`)
            )
          }),
      plugin: requiredString(plugin, 'plugin', `${pluginPath}.plugin`),
      enabled: requiredBoolean(plugin, 'enabled', `${pluginPath}.enabled`)
    };
  });
  const connectors =
    parsed.connectors === undefined
      ? {}
      : requiredRecord(parsed, 'connectors', 'config.connectors');
  const layers = parseLayerConfig(parsed.layers);
  const configManagement =
    parsed.configManagement === undefined
      ? undefined
      : requiredRecord(parsed, 'configManagement', 'config.configManagement');

  return {
    server: {
      ...server,
      id: requiredInteger(server, 'id', 'config.server.id'),
      host: requiredString(server, 'host', 'config.server.host'),
      rconPort: requiredPort(server, 'rconPort', 'config.server.rconPort'),
      rconPassword,
      logReaderMode: mode as 'tail' | 'local' | 'sftp',
      logDir: requiredString(server, 'logDir', 'config.server.logDir'),
      adminLists: parseAdminListSources(server.adminLists),
      ...(sftpConfig
        ? {
            sftp: {
              host: requiredString(sftpConfig, 'host', 'config.server.sftp.host'),
              port: requiredPort(sftpConfig, 'port', 'config.server.sftp.port'),
              username: requiredString(sftpConfig, 'username', 'config.server.sftp.username'),
              password:
                process.env.SQUADJS_SFTP_PASSWORD ??
                requiredString(sftpConfig, 'password', 'config.server.sftp.password')
            }
          }
        : {})
    },
    ...(layers ? { layers } : {}),
    connectors,
    plugins,
    configManagement: {
      reorderOnStartup: optionalBoolean(
        configManagement,
        'reorderOnStartup',
        'config.configManagement.reorderOnStartup',
        false
      ),
      sortPlugins: optionalBoolean(
        configManagement,
        'sortPlugins',
        'config.configManagement.sortPlugins',
        true
      )
    }
  };
}

function parseLayerConfig(value: unknown): RuntimeLayerConfig | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('config.layers: expected an object');
  if (!Array.isArray(value.sources)) throw new Error('config.layers.sources: expected an array');

  const names = new Set<string>();
  const urls = new Set<string>();
  const sources = value.sources.map((source, index) => {
    const path = `config.layers.sources[${index}]`;
    if (!record(source)) throw new Error(`${path}: expected an object`);
    const name = requiredString(source, 'name', `${path}.name`);
    const url = requiredString(source, 'url', `${path}.url`);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`${path}.url: expected a valid HTTPS URL`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`${path}.url: expected a valid HTTPS URL`);
    }
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`${path}.name: duplicate layer source name`);
    if (urls.has(parsedUrl.href)) throw new Error(`${path}.url: duplicate layer source URL`);
    names.add(normalizedName);
    urls.add(parsedUrl.href);
    return { name, url: parsedUrl.href };
  });

  return { sources };
}

function parseNativePluginSource(value: unknown, path: string): RuntimeNativePluginSource {
  if (!record(value)) throw new Error(`${path}: expected an object`);
  const provider = requiredString(value, 'provider', `${path}.provider`);
  if (provider !== 'github') throw new Error(`${path}.provider: expected github`);
  const repository = requiredString(value, 'repository', `${path}.repository`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`${path}.repository: expected owner/repository`);
  }
  const ref = optionalString(value, 'ref', `${path}.ref`, 'main');
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) {
    throw new Error(`${path}.ref: contains unsupported characters`);
  }
  const sourcePath = requiredString(value, 'path', `${path}.path`);
  const parts = sourcePath.split('/');
  if (
    sourcePath.startsWith('/') ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    !/\.(?:mjs|js)$/i.test(sourcePath)
  ) {
    throw new Error(`${path}.path: expected a relative JavaScript file path`);
  }
  return { provider: 'github', repository, ref, path: sourcePath };
}

function parseNativePluginUpdates(value: unknown, path: string): RuntimeNativePluginUpdates {
  if (value === undefined) return { enabled: false, intervalMinutes: 240, apply: 'hot' };
  if (!record(value)) throw new Error(`${path}: expected an object`);
  const intervalMinutes = optionalInteger(value, 'intervalMinutes', `${path}.intervalMinutes`, 240);
  if (intervalMinutes < 5 || intervalMinutes > 10_080) {
    throw new Error(`${path}.intervalMinutes: expected a value between 5 and 10080`);
  }
  const apply = optionalString(value, 'apply', `${path}.apply`, 'hot');
  if (apply !== 'hot' && apply !== 'restart') {
    throw new Error(`${path}.apply: expected hot or restart`);
  }
  return {
    enabled: optionalBoolean(value, 'enabled', `${path}.enabled`, false),
    intervalMinutes,
    apply
  };
}

function validateManagedPluginName(name: string, path: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error(
      `${path}: managed plugin names may contain letters, numbers, dots, dashes, and underscores`
    );
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredRecord(
  parent: Record<string, unknown>,
  key: string,
  path: string
): Record<string, unknown> {
  const value = parent[key];
  if (!record(value)) throw new Error(`${path}: expected an object`);
  return value;
}

function requiredString(parent: Record<string, unknown>, key: string, path: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || !value) throw new Error(`${path}: expected a non-empty string`);
  return value;
}

function optionalString(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  fallback: string
): string {
  if (parent[key] === undefined) return fallback;
  return requiredString(parent, key, path);
}

function requiredBoolean(parent: Record<string, unknown>, key: string, path: string): boolean {
  const value = parent[key];
  if (typeof value !== 'boolean') throw new Error(`${path}: expected a boolean`);
  return value;
}

function optionalBoolean(
  parent: Record<string, unknown> | undefined,
  key: string,
  path: string,
  fallback: boolean
): boolean {
  if (!parent || parent[key] === undefined) return fallback;
  return requiredBoolean(parent, key, path);
}

function requiredInteger(parent: Record<string, unknown>, key: string, path: string): number {
  const value = parent[key];
  if (!Number.isInteger(value)) throw new Error(`${path}: expected an integer`);
  return value as number;
}

function optionalInteger(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number
): number {
  if (parent[key] === undefined) return fallback;
  return requiredInteger(parent, key, path);
}

function requiredPort(parent: Record<string, unknown>, key: string, path: string): number {
  const value = requiredInteger(parent, key, path);
  if (value < 1 || value > 65_535) throw new Error(`${path}: expected a port between 1 and 65535`);
  return value;
}
