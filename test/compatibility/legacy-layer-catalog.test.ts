import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LegacyLayerCatalog } from '../../src/compatibility/legacy-layer-catalog.js';

test('resolves legacy layers and supplies a stable fallback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-layer-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = join(directory, 'layers.mjs');
  await writeFile(
    modulePath,
    `export default {
      sources: [],
      configureSources(value) { this.sources = value; },
      async pull() {
        if (this.sources[0]?.name !== 'Configured') throw new Error('sources were not configured');
      },
      async getLayerById(id) {
        if (id === 'Known_AAS_v1') return { name: 'Known', layerid: id, teams: [] };
        if (id.startsWith('JensensRange_')) return { name: 'Unknown', layerid: id, teams: [] };
        if (id.startsWith('PacificProvingGrounds_')) return { name: 'Unknown', layerid: id, teams: [] };
        return null;
      },
      async getLayerByClassname(name) { return name === 'KnownClass' ? { name: 'Known', classname: name, layerid: 'Known_AAS_v1' } : null; }
    };`
  );
  const catalog = new LegacyLayerCatalog({
    modulePath,
    sources: [{ name: 'Configured', url: 'https://example.com/layers.json' }]
  });
  await catalog.prepare();

  assert.equal(
    (
      await catalog.byInformation({
        level: 'KnownMap',
        layer: 'Known_AAS_v1',
        team1Faction: null,
        team2Faction: null
      })
    )?.name,
    'Known'
  );
  assert.deepEqual(
    await catalog.byInformation({
      level: 'FallbackMap',
      layer: 'Fallback_RAAS_v1',
      team1Faction: null,
      team2Faction: null
    }),
    {
      name: 'Fallback_RAAS_v1',
      layerid: 'Fallback_RAAS_v1',
      classname: 'FallbackMap',
      map: { name: 'FallbackMap' },
      teams: []
    }
  );
  assert.deepEqual(await catalog.byClassname('UnknownClass', 'UnknownMap'), {
    name: 'UnknownClass',
    classname: 'UnknownClass',
    layerid: 'UnknownClass',
    map: { name: 'UnknownMap' }
  });

  for (const layer of [
    'JensensRange_WPMC-TLF',
    'JensensRange_USMC-GFI',
    'JensensRange_USA-PLA',
    'JensensRange_CRF-VDV',
    'JensensRange_CAF-MEI',
    'JensensRange_BAF-IMF',
    'JensensRange_AFU-RGF',
    'JensensRange_ADF-PLAAGF'
  ]) {
    assert.equal(
      (
        await catalog.byInformation({
          level: layer,
          layer,
          team1Faction: null,
          team2Faction: null
        })
      )?.name,
      "Jensen's Range"
    );
  }

  for (const layer of [
    'PacificProvingGrounds_USMC-RGF',
    'PacificProvingGrounds_Seed_v1',
    'PacificProvingGrounds_PLANMC-VDV',
    'PacificProvingGrounds_AAS_v1'
  ]) {
    assert.equal(
      (
        await catalog.byInformation({
          level: layer,
          layer,
          team1Faction: null,
          team2Faction: null
        })
      )?.name,
      'Pacific Proving Grounds'
    );
  }
});
