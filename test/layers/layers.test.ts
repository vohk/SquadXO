import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface NormalizedTeam {
  faction?: string;
  tickets?: number;
  vehicles?: { rawType?: string }[];
}

interface NormalizedLayer {
  rawName?: string;
  team1?: NormalizedTeam;
  team2?: NormalizedTeam;
}

interface LayerInstance {
  layerid?: string;
  teams: {
    faction?: string;
    tickets?: number;
    vehicles: { classname?: string; classNames?: string[] }[];
    numberOfTanks: number;
    numberOfHelicopters: number;
  }[];
}

const layersModule = (await import(
  pathToFileURL(resolve('squad-server/layers/layers.js')).href
)) as {
  DEFAULT_LAYER_SOURCES: readonly { name: string; url: string }[];
  Layers: new (sources?: readonly { name: string; url: string }[]) => {
    sources: { name: string; url: string }[];
    layers: unknown[];
    pulled: boolean;
    configureSources(sources: readonly { name: string; url: string }[]): void;
  };
  normalizeLayerPayload(payload: unknown): NormalizedLayer[];
};
const { default: Layer } = (await import(
  pathToFileURL(resolve('squad-server/layers/layer.js')).href
)) as {
  default: new (data: NormalizedLayer) => LayerInstance;
};

test('uses only vanilla by default and replaces sources when configured', () => {
  const layers = new layersModule.Layers();
  assert.deepEqual(layers.sources, layersModule.DEFAULT_LAYER_SOURCES);
  assert.equal(layers.sources.length, 1);

  layers.layers = [{}];
  layers.pulled = true;
  layers.configureSources([{ name: 'Example Mod', url: 'https://example.com/layers.json' }]);

  assert.deepEqual(layers.sources, [
    { name: 'Example Mod', url: 'https://example.com/layers.json' }
  ]);
  assert.deepEqual(layers.layers, []);
  assert.equal(layers.pulled, false);
});

test('normalizes compact layer-list teams and vehicles for legacy consumers', () => {
  const [normalized] = layersModule.normalizeLayerPayload({
    Maps: [
      {
        Name: 'Test Layer',
        rawName: 'Test_AAS_v1',
        teamConfigs: {
          team1: { defaultFactionUnit: 'USA_CA', tickets: 300 },
          team2: { defaultFactionUnit: 'RGF_CA', tickets: 250 }
        }
      }
    ],
    Units: {
      USA_CA: {
        factionName: 'United States Army',
        vehicles: [
          {
            type: 'M1A2',
            classNames: ['BP_M1A2_C'],
            count: 1,
            delay: 0,
            respawnTime: 20,
            icon: 'map_tank'
          }
        ]
      },
      RGF_CA: {
        factionName: 'Russian Ground Forces',
        vehicles: [
          {
            type: 'Mi-8',
            classNames: ['BP_MI8_C'],
            count: 1,
            delay: 0,
            respawnTime: 20,
            icon: 'map_helo'
          }
        ]
      }
    }
  });

  assert.ok(normalized);
  assert.equal(normalized.team1?.faction, 'United States Army');
  assert.equal(normalized.team1?.tickets, 300);
  assert.equal(normalized.team1?.vehicles?.[0]?.rawType, 'BP_M1A2_C');

  const layer = new Layer(normalized);
  assert.equal(layer.layerid, 'Test_AAS_v1');
  assert.equal(layer.teams[0]?.numberOfTanks, 1);
  assert.equal(layer.teams[1]?.numberOfHelicopters, 1);
  assert.equal(layer.teams[1]?.vehicles[0]?.classname, 'BP_MI8_C');
  assert.deepEqual(layer.teams[0]?.vehicles[0]?.classNames, ['BP_M1A2_C']);
});

test('preserves already-expanded legacy layer-list records', () => {
  const legacy = {
    rawName: 'Legacy_AAS_v1',
    team1: { faction: 'USA', tickets: 300, vehicles: [] },
    team2: { faction: 'RGF', tickets: 300, vehicles: [] }
  };

  const [normalized] = layersModule.normalizeLayerPayload({ Maps: [legacy] });

  assert.equal(normalized, legacy);
  assert.doesNotThrow(() => new Layer(normalized!));
});

test('handles unresolved compact units without crashing layer construction', () => {
  const [normalized] = layersModule.normalizeLayerPayload({
    Maps: [{ rawName: 'Unknown_AAS_v1', teamConfigs: { team1: {}, team2: {} } }],
    Units: {}
  });

  assert.ok(normalized);
  const layer = new Layer(normalized);
  assert.deepEqual(layer.teams[0]?.vehicles, []);
  assert.deepEqual(layer.teams[1]?.vehicles, []);
});

test('rejects malformed layer-list responses', () => {
  assert.throws(
    () => layersModule.normalizeLayerPayload({ Units: {} }),
    /does not contain a Maps array/
  );
});
