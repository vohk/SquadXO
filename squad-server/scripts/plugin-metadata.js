import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Plugins from '../plugins/index.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const templates = path.join(repository, 'squad-server/templates');

export async function readNativePlugins(sources, outputRoot) {
  const root = outputRoot ?? path.join(repository, 'dist');
  sources ??= await builtinSources(path.join(repository, 'src/plugins/builtin'));
  const entries = [];
  const names = new Set();
  for (const source of sources) {
    if (!source.startsWith('src/plugins/builtin/') || source.endsWith('.d.ts')) continue;
    const module = `./dist/${source.replace(/\.ts$/, '.js')}`;
    const imported = await import(
      pathToFileURL(path.join(root, source.replace(/\.ts$/, '.js'))).href
    );
    const definition = imported.default ?? imported.plugin;
    if (!definition || typeof definition !== 'object' || !('apiVersion' in definition)) continue;
    if (
      definition.apiVersion !== 1 ||
      typeof definition.name !== 'string' ||
      typeof definition.create !== 'function' ||
      !definition.options ||
      !definition.connectors
    ) {
      throw new Error(`Invalid native metadata definition: ${source}`);
    }
    if (names.has(definition.name))
      throw new Error(`Duplicate native metadata name: ${definition.name}`);
    names.add(definition.name);
    entries.push({ module, definition });
  }
  return entries.sort((left, right) => left.definition.name.localeCompare(right.definition.name));
}

export function nativeConfig(entry, configured = {}) {
  const { definition, module } = entry;
  const options = {};
  for (const [name, declaration] of Object.entries(definition.options)) {
    const value = Object.hasOwn(configured.options ?? {}, name)
      ? configured.options[name]
      : (declaration.default ?? placeholder(declaration.type));
    options[name] = generatedConfigValue(name, value);
  }
  for (const name of Object.keys(configured.options ?? {})) {
    if (!Object.hasOwn(definition.options, name))
      throw new Error(`${definition.name}: unknown template option ${name}`);
  }
  const connectors = {};
  for (const [alias, declaration] of Object.entries(definition.connectors)) {
    const value = configured.connectors?.[alias];
    if (value !== undefined || declaration.required !== false)
      connectors[alias] = value ?? (declaration.type === 'discord' ? 'discord' : 'sqlite');
  }
  for (const alias of Object.keys(configured.connectors ?? {})) {
    if (!Object.hasOwn(definition.connectors, alias))
      throw new Error(`${definition.name}: unknown template connector ${alias}`);
  }
  return {
    ...configured,
    type: 'native',
    name: definition.name,
    ...(configured.source === undefined ? { module: configured.module ?? module } : {}),
    enabled: configured.enabled ?? false,
    connectors,
    options
  };
}

function placeholder(type) {
  return { string: '', number: 0, boolean: false, 'string[]': [], object: {} }[type];
}

async function catalog(overrides) {
  return {
    legacy: overrides.legacy ?? (await Plugins.getPlugins()),
    native: overrides.native ?? (await readNativePlugins())
  };
}

export async function buildConfig(overrides = {}) {
  const { legacy, native } = await catalog(overrides);
  const template =
    overrides.template ??
    JSON.parse(await fs.readFile(path.join(templates, 'config-template.json'), 'utf8'));
  const configured = template.plugins ?? [];
  const entries = new Map(configured.map((entry) => [pluginConfigKey(entry), entry]));
  for (const name of sortedPluginNames(legacy)) {
    const Plugin = legacy[name];
    const defaults = Object.fromEntries(
      Object.entries(Plugin.optionsSpecification).map(([key, option]) => [
        key,
        generatedConfigValue(key, option.default)
      ])
    );
    const key = `legacy:${name}`;
    entries.set(key, {
      plugin: name,
      enabled: Plugin.defaultEnabled,
      ...defaults,
      ...entries.get(key)
    });
  }
  for (const entry of native) {
    const key = `native:${entry.definition.name}`;
    entries.set(key, nativeConfig(entry, entries.get(key)));
  }
  const plugins = [...entries.values()].sort((left, right) =>
    pluginConfigName(left).localeCompare(pluginConfigName(right), undefined, {
      sensitivity: 'base'
    })
  );
  return { ...template, plugins };
}

export async function buildConfigFile(outputPath = path.join(repository, 'config.example.json')) {
  await fs.writeFile(outputPath, `${JSON.stringify(await buildConfig(), null, 2)}\n`);
}

export async function buildReadme() {
  return fs.readFile(path.join(templates, 'readme-template.md'), 'utf8');
}

export async function buildReference(overrides = {}) {
  const { legacy, native } = await catalog(overrides);
  const legacyInfo = sortedPluginNames(legacy).map((name) => {
    const Plugin = legacy[name];
    const rows = Object.entries(Plugin.optionsSpecification).map(([key, option]) => [
      code(key),
      option.required ? 'yes' : 'no',
      option.connector ? code(option.connector) : '—',
      code(displayGeneratedValue(key, option.default)),
      cell(option.description)
    ]);
    return `### ${name}\n\nGenerated enabled default: ${code(Plugin.defaultEnabled)}.\n\n${table(['Option', 'Required', 'Connector', 'Default', 'Description'], rows)}`;
  });
  const nativeInfo = native.map(({ module, definition }) => {
    const optionRows = Object.entries(definition.options).map(([key, option]) => [
      code(key),
      code(option.type),
      option.required ? 'yes' : 'no',
      code(displayGeneratedValue(key, option.default)),
      cell(option.description)
    ]);
    const connectorRows = Object.entries(definition.connectors).map(([alias, declaration]) => [
      code(alias),
      code(declaration.type),
      declaration.required === false ? 'no' : 'yes',
      cell(declaration.description)
    ]);
    return `### ${definition.name}\n\n${definition.description ? `${definition.description}\n\n` : ''}Module: ${code(module)} · API: ${code(definition.apiVersion)}.\n\n${table(['Alias', 'Connector type', 'Required', 'Description'], connectorRows)}\n${table(['Option', 'Type', 'Required', 'Default', 'Description'], optionRows)}`;
  });
  const template = await fs.readFile(path.join(templates, 'reference-template.md'), 'utf8');
  return (
    template
      .replace('//LEGACY-PLUGIN-INFO//', legacyInfo.join('\n'))
      .replace('//NATIVE-PLUGIN-INFO//', nativeInfo.join('\n'))
      .trimEnd() + '\n'
  );
}

export async function buildReferenceFile(
  outputPath = path.join(repository, 'docs/reference/plugins.md')
) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await buildReference());
}

export async function buildReadmeFile(outputPath = path.join(repository, 'README.md')) {
  await fs.writeFile(outputPath, await buildReadme());
  await buildReferenceFile();
}

function table(headers, rows) {
  if (rows.length === 0) return 'None.\n';
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
}

function cell(value) {
  return String(value ?? '—')
    .replace(/\s+/g, ' ')
    .replaceAll('|', '\\|');
}

function code(value) {
  return '`' + cell(value).replaceAll('`', '&#96;') + '`';
}

function sortedPluginNames(plugins) {
  return Object.keys(plugins).sort((left, right) => left.localeCompare(right));
}
function pluginConfigName(plugin) {
  return plugin.type === 'native' ? plugin.name : plugin.plugin;
}
function pluginConfigKey(plugin) {
  return `${plugin.type === 'native' ? 'native' : 'legacy'}:${pluginConfigName(plugin)}`;
}
function isCredentialOption(name) {
  return /(api.?key|password|secret|token|webhook)/i.test(name);
}
function generatedConfigValue(name, value) {
  return isCredentialOption(name) && value != null ? '' : value;
}
function displayGeneratedValue(name, value) {
  if (value === undefined) return 'no default';
  if (isCredentialOption(name) && value != null) return '[redacted]';
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

async function builtinSources(directory) {
  const sources = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...(await builtinSources(file)));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
      sources.push(path.relative(repository, file).split(path.sep).join('/'));
  }
  return sources.sort();
}
