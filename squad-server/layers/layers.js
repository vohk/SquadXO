import axios from 'axios';

import Logger from 'core/logger';

import Layer from './layer.js';

export const DEFAULT_LAYER_SOURCES = Object.freeze([
  Object.freeze({
    name: 'Squad',
    url: 'https://raw.githubusercontent.com/fantinodavide/SquadLayerList/main/layers.json'
  })
]);

function expandTeam(teamConfig = {}, units = {}) {
  const unit = units[teamConfig.defaultFactionUnit] ?? {};

  return {
    ...teamConfig,
    ...unit,
    faction: unit.faction ?? unit.factionName,
    vehicles: (unit.vehicles ?? teamConfig.vehicles ?? []).map((vehicle) => ({
      ...vehicle,
      rawType: vehicle.rawType ?? vehicle.classNames?.[0]
    }))
  };
}

export function normalizeLayerPayload(payload) {
  if (!Array.isArray(payload?.Maps)) {
    throw new TypeError('Layer list response does not contain a Maps array.');
  }

  const units = payload.Units ?? {};

  return payload.Maps.map((layer) => {
    if (layer.team1 || layer.team2) return layer;

    return {
      ...layer,
      team1: expandTeam(layer.teamConfigs?.team1, units),
      team2: expandTeam(layer.teamConfigs?.team2, units)
    };
  });
}

export class Layers {
  constructor(sources = DEFAULT_LAYER_SOURCES) {
    this.sources = [];
    this.layers = [];
    this.pulled = false;

    this.configureSources(sources);
  }

  configureSources(sources) {
    if (!Array.isArray(sources)) throw new TypeError('Layer sources must be an array.');
    this.sources = sources.map((source) => {
      if (!source || typeof source.name !== 'string' || typeof source.url !== 'string') {
        throw new TypeError('Each layer source must have a name and URL.');
      }
      return { name: source.name, url: source.url };
    });
    this.layers = [];
    this.pulled = false;
  }

  async pull(force = false) {
    if (this.pulled && !force) {
      Logger.verbose('Layers', 2, 'Already pulled layers.');
      return;
    }
    if (force) Logger.verbose('Layers', 1, 'Forcing update to layer information...');

    this.layers = [];

    const results = await Promise.all(
      this.sources.map(async (source) => {
        Logger.verbose('Layers', 1, `Pulling ${source.name} layers from ${source.url}...`);
        try {
          const response = await axios.get(source.url, { timeout: 10_000 });
          return normalizeLayerPayload(response.data).map((layer) => new Layer(layer));
        } catch (error) {
          Logger.verbose(
            'Layers',
            1,
            `Error pulling ${source.name} layer list ${source.url}: ${error}`
          );
          return [];
        }
      })
    );
    for (const layers of results) {
      this.layers.push(...layers);
    }

    Logger.verbose('Layers', 1, `Pulled ${this.layers.length} layers.`);

    this.pulled = true;

    return this.layers;
  }

  async getLayerByCondition(condition) {
    await this.pull();

    const matches = this.layers.filter(condition);
    if (matches.length === 1) return matches[0];

    return null;
  }

  getLayerById(layerId) {
    return this.getLayerByCondition((layer) => layer.layerid === layerId);
  }

  getLayerByClassname(classname) {
    return this.getLayerByCondition((layer) => layer.classname === classname);
  }
}

export default new Layers();
