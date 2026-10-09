import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeLayerSource } from '../config/runtime-config.js';
import type { LayerInformation } from '../rcon/squad-protocol.js';

export type LegacyLayer = Readonly<Record<string, unknown>>;

interface LegacyLayersModule {
  readonly default: {
    configureSources(sources: readonly RuntimeLayerSource[]): void;
    pull(force?: boolean): Promise<unknown>;
    getLayerById(id: string): Promise<LegacyLayer | null>;
    getLayerByClassname(classname: string): Promise<LegacyLayer | null>;
  };
}

export class LegacyLayerCatalog {
  readonly #modulePath: string;
  readonly #sources: readonly RuntimeLayerSource[] | undefined;
  #module: Promise<LegacyLayersModule> | undefined;

  constructor(
    options: {
      readonly modulePath?: string;
      readonly sources?: readonly RuntimeLayerSource[];
    } = {}
  ) {
    this.#modulePath = options.modulePath ?? resolve('squad-server/layers/layers.js');
    this.#sources = options.sources;
  }

  async prepare(): Promise<void> {
    const layers = (await this.#load()).default;
    if (this.#sources) layers.configureSources(this.#sources);
    await layers.pull();
  }

  async byInformation(information: LayerInformation): Promise<LegacyLayer | undefined> {
    const layers = (await this.#load()).default;
    const resolved = information.layer ? await layers.getLayerById(information.layer) : null;
    return withKnownDisplayName(
      resolved ?? fallbackLayer(information),
      information.layer,
      information.level
    );
  }

  async byClassname(classname: string, mapClassname: string = classname): Promise<LegacyLayer> {
    const resolved = await (await this.#load()).default.getLayerByClassname(classname);
    return withKnownDisplayName(
      resolved ?? { name: classname, classname, layerid: classname, map: { name: mapClassname } },
      classname
    )!;
  }

  #load(): Promise<LegacyLayersModule> {
    this.#module ??= import(pathToFileURL(this.#modulePath).href) as Promise<LegacyLayersModule>;
    return this.#module;
  }
}

export function knownLayerDisplayName(identifier: unknown): string | undefined {
  if (typeof identifier !== 'string') return undefined;
  if (/^JensensRange(?:_[A-Z0-9]+-[A-Z0-9]+)?$/i.test(identifier)) {
    return "Jensen's Range";
  }
  if (/^PacificProvingGrounds(?:_[A-Z0-9]+-[A-Z0-9]+|_[A-Z0-9]+_v\d+)?$/i.test(identifier)) {
    return 'Pacific Proving Grounds';
  }
  return undefined;
}

function withKnownDisplayName(
  layer: LegacyLayer | undefined,
  ...identifiers: readonly unknown[]
): LegacyLayer | undefined {
  if (!layer) return undefined;
  const name = identifiers.map(knownLayerDisplayName).find(Boolean);
  return name ? { ...layer, name } : layer;
}

function fallbackLayer(information: LayerInformation): LegacyLayer | undefined {
  const name = information.layer ?? information.level;
  if (!name) return undefined;
  return {
    name,
    layerid: information.layer ?? name,
    classname: information.level ?? name,
    map: { name: information.level ?? name },
    teams: []
  };
}
