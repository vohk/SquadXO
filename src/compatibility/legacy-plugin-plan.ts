import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeLegacyPluginConfig } from '../config/runtime-config.js';
import type { LegacyPluginConstructor } from './legacy-plugin-loader.js';

const INFRASTRUCTURE_FILES = new Set([
  'index.js',
  'base-plugin.js',
  'discord-base-message-updater.js',
  'discord-base-plugin.js'
]);

const LEGACY_PLUGIN_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {};
export const KNOWN_INCOMPATIBLE_LEGACY_PLUGINS: Readonly<Record<string, string>> = {};

export interface PlannedLegacyPlugin {
  readonly name: string;
  readonly path: string;
  readonly PluginClass: LegacyPluginConstructor;
  readonly config: RuntimeLegacyPluginConfig;
}

export interface ConnectorRequirement {
  readonly name: string;
  readonly type: string;
  readonly plugin: string;
}

export interface LegacyPluginPlan {
  readonly plugins: readonly PlannedLegacyPlugin[];
  readonly connectors: readonly ConnectorRequirement[];
  readonly skipped: Readonly<Record<string, string>>;
}

export async function createLegacyPluginPlan(
  configs: readonly RuntimeLegacyPluginConfig[],
  pluginsDirectory = resolve('squad-server/plugins')
): Promise<LegacyPluginPlan> {
  const enabled = configs.filter((config) => config.enabled);
  if (enabled.length === 0) return { plugins: [], connectors: [], skipped: {} };
  const requested = new Set(
    enabled.filter((config) => !config.module).map((config) => config.plugin)
  );
  requested.delete('DBLog');
  const classes = new Map<string, { path: string; PluginClass: LegacyPluginConstructor }>();

  for (const filename of requested.size > 0 ? await readdir(pluginsDirectory) : []) {
    if (!filename.endsWith('.js')) continue;
    if (INFRASTRUCTURE_FILES.has(filename)) continue;
    const minified = filename.endsWith('.min.js');
    const stem = filename
      .replace(/(?:\.build)?\.min\.js$/, '')
      .replace(/^squadjs-/, '')
      .replace(/[-_]/g, '')
      .toLowerCase();
    const bundledName = minified
      ? [...requested].find((name) => name.toLowerCase() === stem)
      : undefined;
    if (minified && !bundledName) continue;
    const path = resolve(pluginsDirectory, filename);
    const source = minified ? '' : await readFile(path, 'utf8');
    const exportedClass =
      source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/)?.[1] ?? bundledName;
    if (!exportedClass || !requested.has(exportedClass)) continue;
    let imported: { readonly default?: LegacyPluginConstructor };
    try {
      imported = (await import(pathToFileURL(path).href)) as {
        readonly default?: LegacyPluginConstructor;
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to import legacy plugin module ${filename}: ${detail}`, {
        cause: error
      });
    }
    if (imported.default && imported.default.name === exportedClass) {
      classes.set(imported.default.name, { path, PluginClass: imported.default });
    }
  }

  for (const config of enabled.filter((entry) => entry.module)) {
    if (config.plugin === 'DBLog')
      throw new Error('DBLog is handled by the TypeScript core; module is not supported');
    if (!config.modulePath)
      throw new Error(`${config.plugin}: external module has not been resolved`);
    let imported: { default?: LegacyPluginConstructor };
    try {
      imported = (await import(pathToFileURL(config.modulePath).href)) as {
        default?: LegacyPluginConstructor;
      };
    } catch (error) {
      throw new Error(`Failed to import external legacy plugin ${config.plugin}`, { cause: error });
    }
    if (typeof imported.default !== 'function' || imported.default.name !== config.plugin) {
      throw new Error(
        `${config.plugin}: external module must export a default class with the configured plugin name`
      );
    }
    classes.set(config.modulePath, { path: config.modulePath, PluginClass: imported.default });
  }

  const plugins: PlannedLegacyPlugin[] = [];
  const connectorByName = new Map<string, ConnectorRequirement>();
  const skipped: Record<string, string> = {};
  for (const config of enabled) {
    const incompatibility = KNOWN_INCOMPATIBLE_LEGACY_PLUGINS[config.plugin];
    if (incompatibility) {
      skipped[config.plugin] = incompatibility;
      continue;
    }
    if (config.plugin === 'DBLog') {
      skipped[config.plugin] = 'handled by the TypeScript core';
      const connectorName = config.database;
      if (typeof connectorName !== 'string' || !connectorName) {
        throw new Error('DBLog: database (sequelize connector) is missing');
      }
      connectorByName.set(connectorName, {
        name: connectorName,
        type: 'sequelize',
        plugin: config.plugin
      });
      continue;
    }
    const resolved = classes.get(config.module ? config.modulePath! : config.plugin);
    if (!resolved) throw new Error(`Enabled plugin does not exist: ${config.plugin}`);
    plugins.push({ name: config.plugin, ...resolved, config });

    for (const [optionName, option] of Object.entries(
      resolved.PluginClass.optionsSpecification ?? {}
    )) {
      if (!option.connector) continue;
      const connectorName = config[optionName];
      if (typeof connectorName !== 'string' || !connectorName) {
        if (option.required) {
          throw new Error(
            `${config.plugin}: ${optionName} (${option.connector} connector) is missing`
          );
        }
        continue;
      }
      const existing = connectorByName.get(connectorName);
      if (existing && existing.type !== option.connector) {
        throw new Error(
          `Connector ${connectorName} is requested as both ${existing.type} and ${option.connector}`
        );
      }
      connectorByName.set(connectorName, {
        name: connectorName,
        type: option.connector,
        plugin: config.plugin
      });
    }
  }

  return {
    plugins: orderByDeclaredDependencies(plugins),
    connectors: [...connectorByName.values()],
    skipped
  };
}

function orderByDeclaredDependencies(
  plugins: readonly PlannedLegacyPlugin[]
): readonly PlannedLegacyPlugin[] {
  const indexesByName = new Map<string, number[]>();
  for (const [index, plugin] of plugins.entries()) {
    const indexes = indexesByName.get(plugin.name) ?? [];
    indexes.push(index);
    indexesByName.set(plugin.name, indexes);
  }

  const state = new Array<number>(plugins.length).fill(0);
  const ordered: PlannedLegacyPlugin[] = [];

  const visit = (index: number, chain: readonly string[]): void => {
    if (state[index] === 2) return;
    const plugin = plugins[index];
    if (!plugin) throw new Error(`Legacy plugin dependency index is invalid: ${index}`);
    if (state[index] === 1) {
      throw new Error(`Legacy plugin dependency cycle: ${[...chain, plugin.name].join(' -> ')}`);
    }

    state[index] = 1;
    for (const dependency of LEGACY_PLUGIN_DEPENDENCIES[plugin.name] ?? []) {
      for (const dependencyIndex of indexesByName.get(dependency) ?? []) {
        visit(dependencyIndex, [...chain, plugin.name]);
      }
    }
    state[index] = 2;
    ordered.push(plugin);
  };

  for (const index of plugins.keys()) visit(index, []);
  return ordered;
}
