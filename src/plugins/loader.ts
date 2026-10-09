import { pathToFileURL } from 'node:url';
import type { ConnectorRequirement } from '../compatibility/legacy-plugin-plan.js';
import type {
  RuntimeNativePluginConfig,
  RuntimeResolvedNativePluginConfig
} from '../config/runtime-config.js';
import {
  PLUGIN_API_VERSION,
  type NativeConnectorDeclaration,
  type NativeOptionDeclaration,
  type NativePluginDefinition,
  type ResolvedNativeOptions
} from './api.js';
import type { PluginRuntime } from './runtime.js';

export interface PlannedNativePlugin {
  readonly name: string;
  readonly definition: NativePluginDefinition;
  readonly options: Readonly<Record<string, unknown>>;
  readonly connectors: Readonly<Record<string, string>>;
}

export interface NativePluginPlan {
  readonly plugins: readonly PlannedNativePlugin[];
  readonly connectors: readonly ConnectorRequirement[];
}

export async function createNativePluginPlan(
  configs: readonly RuntimeNativePluginConfig[]
): Promise<NativePluginPlan> {
  const plugins: PlannedNativePlugin[] = [];
  const connectorByName = new Map<string, ConnectorRequirement>();
  const instanceNames = new Set<string>();

  for (const config of configs.filter((entry) => entry.enabled)) {
    if (!isResolvedConfig(config)) {
      throw new Error(`Managed native plugin ${config.name} has not been resolved to a revision`);
    }
    if (instanceNames.has(config.name))
      throw new Error(`Duplicate native plugin name: ${config.name}`);
    instanceNames.add(config.name);
    const definition = await importDefinition(config);
    if (definition.name !== config.name) {
      throw new Error(`Native plugin ${config.name}: module declares the name ${definition.name}`);
    }
    const options = resolveOptions(config.name, definition.options, config.options);
    const connectors = resolveConnectors(config.name, definition.connectors, config.connectors);
    for (const [alias, connectorName] of Object.entries(connectors)) {
      const declaration = definition.connectors[alias];
      if (!declaration) continue;
      const existing = connectorByName.get(connectorName);
      if (existing && existing.type !== declaration.type) {
        throw new Error(
          `Connector ${connectorName} is requested as both ${existing.type} and ${declaration.type}`
        );
      }
      connectorByName.set(connectorName, {
        name: connectorName,
        type: declaration.type,
        plugin: config.name
      });
    }
    plugins.push({ name: config.name, definition, options, connectors });
  }

  return { plugins, connectors: [...connectorByName.values()] };
}

function isResolvedConfig(
  config: RuntimeNativePluginConfig
): config is RuntimeResolvedNativePluginConfig {
  return typeof config.module === 'string' && typeof config.modulePath === 'string';
}

export async function mountNativePlugin(
  runtime: PluginRuntime,
  planned: PlannedNativePlugin
): Promise<void> {
  let plugin;
  try {
    plugin = planned.definition.create();
  } catch (error) {
    throw startupError(planned.name, 'create', error);
  }
  if (!plugin || typeof plugin.mount !== 'function') {
    throw new Error(`Native plugin ${planned.name}: create must return a plugin with mount()`);
  }
  try {
    await runtime.mount(planned.name, plugin, planned.options, planned.connectors);
  } catch (error) {
    throw startupError(planned.name, 'mount', error);
  }
}

async function importDefinition(
  config: RuntimeResolvedNativePluginConfig
): Promise<NativePluginDefinition> {
  let imported: { readonly default?: unknown; readonly plugin?: unknown };
  try {
    imported = (await import(pathToFileURL(config.modulePath).href)) as {
      readonly default?: unknown;
      readonly plugin?: unknown;
    };
  } catch (error) {
    throw startupError(config.name, 'import', error);
  }
  const definition = imported.default ?? imported.plugin;
  if (!isDefinition(definition)) {
    throw new Error(
      `Native plugin ${config.name}: module must export a plugin definition as default or "plugin"`
    );
  }
  if (definition.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `Native plugin ${config.name}: unsupported API version ${String(definition.apiVersion)}; expected ${PLUGIN_API_VERSION}`
    );
  }
  validateSchema(config.name, definition);
  return definition;
}

function validateSchema(name: string, definition: NativePluginDefinition): void {
  for (const [optionName, declaration] of Object.entries(definition.options)) {
    if (!isOptionDeclaration(declaration)) {
      throw new Error(`Native plugin ${name}: invalid option declaration ${optionName}`);
    }
    if (declaration.default !== undefined && !matchesType(declaration.default, declaration.type)) {
      throw new Error(`Native plugin ${name}: invalid default for option ${optionName}`);
    }
  }
  for (const [alias, declaration] of Object.entries(definition.connectors)) {
    if (!isConnectorDeclaration(declaration)) {
      throw new Error(`Native plugin ${name}: invalid connector declaration ${alias}`);
    }
  }
}

function resolveOptions(
  plugin: string,
  schema: NativePluginDefinition['options'],
  configured: Readonly<Record<string, unknown>>
): ResolvedNativeOptions<NativePluginDefinition['options']> {
  rejectUnknown(plugin, 'option', configured, schema);
  const resolved: Record<string, unknown> = {};
  for (const [name, declaration] of Object.entries(schema)) {
    const value = Object.hasOwn(configured, name) ? configured[name] : declaration.default;
    if (value === undefined) {
      if (declaration.required)
        throw new Error(`Native plugin ${plugin}: option ${name} is required`);
      continue;
    }
    if (!matchesType(value, declaration.type)) {
      throw new Error(`Native plugin ${plugin}: option ${name} must be ${declaration.type}`);
    }
    resolved[name] = value;
  }
  return resolved as ResolvedNativeOptions<NativePluginDefinition['options']>;
}

function resolveConnectors(
  plugin: string,
  schema: NativePluginDefinition['connectors'],
  configured: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  rejectUnknown(plugin, 'connector', configured, schema);
  const resolved: Record<string, string> = {};
  for (const [alias, declaration] of Object.entries(schema)) {
    const connectorName = configured[alias];
    if (!connectorName) {
      if (declaration.required !== false) {
        throw new Error(`Native plugin ${plugin}: connector ${alias} is required`);
      }
      continue;
    }
    resolved[alias] = connectorName;
  }
  return resolved;
}

function rejectUnknown(
  plugin: string,
  kind: string,
  configured: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>
): void {
  const unknown = Object.keys(configured).find((name) => !(name in schema));
  if (unknown) throw new Error(`Native plugin ${plugin}: unknown ${kind} ${unknown}`);
}

function isDefinition(value: unknown): value is NativePluginDefinition {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as NativePluginDefinition).name === 'string' &&
    typeof (value as NativePluginDefinition).create === 'function' &&
    isRecord((value as NativePluginDefinition).options) &&
    isRecord((value as NativePluginDefinition).connectors)
  );
}

function isOptionDeclaration(value: unknown): value is NativeOptionDeclaration {
  return Boolean(
    isRecord(value) &&
    ['string', 'number', 'boolean', 'string[]', 'object'].includes(String(value.type)) &&
    (value.required === undefined || typeof value.required === 'boolean')
  );
}

function isConnectorDeclaration(value: unknown): value is NativeConnectorDeclaration {
  return Boolean(
    isRecord(value) &&
    ['discord', 'sequelize'].includes(String(value.type)) &&
    (value.required === undefined || typeof value.required === 'boolean')
  );
}

function matchesType(value: unknown, type: NativeOptionDeclaration['type']): boolean {
  if (type === 'string[]') {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  }
  if (type === 'object') return isRecord(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function startupError(plugin: string, stage: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Native plugin ${plugin} failed during ${stage}: ${detail}`, { cause: error });
}
