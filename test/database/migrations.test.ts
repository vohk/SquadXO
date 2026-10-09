import assert from 'node:assert/strict';
import test from 'node:test';
import { DataTypes, QueryTypes, Sequelize } from 'sequelize';
import {
  EOS_BACKFILL_METADATA_KEY,
  readEosBackfillState
} from '../../src/database/eos-backfill.js';
import { DbLog } from '../../src/database/db-log.js';
import { migrateDbLog } from '../../src/database/migrations.js';
import {
  createDbLogSchema,
  createMetadataTable,
  dbLogTableName
} from '../../src/database/schema.js';

test('rejects newer and materially incomplete versioned DBLog schemas', async () => {
  const newer = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await createDbLogSchema(newer);
    await newer
      .getQueryInterface()
      .bulkUpdate('DBLog_Metadata', { value: '99' }, { key: 'schemaVersion' });
    await assert.rejects(migrateDbLog(newer), /newer than supported/);
  } finally {
    await newer.close();
  }

  const incomplete = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await createDbLogSchema(incomplete, { legacy: true });
    await createMetadataTable(incomplete, 1);
    await assert.rejects(migrateDbLog(incomplete), /missing column DBLog_Wounds.attackerEOSID/);
  } finally {
    await incomplete.close();
  }
});

test('repairs missing match display fields idempotently and preserves quality filters', async () => {
  const completed = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await createDbLogSchema(completed);
    await completed.getQueryInterface().bulkInsert('DBLog_Servers', [{ id: 1, name: 'Server' }]);
    await completed.getQueryInterface().bulkInsert('DBLog_Matches', [
      {
        id: 1,
        server: 1,
        mapClassname: 'Sumari',
        layerClassname: 'Sumari_Seed_v1',
        map: null,
        layer: "Jensen's Range",
        startTime: new Date('2026-08-22T00:00:00Z')
      },
      {
        id: 2,
        server: 1,
        mapClassname: 'Jensens_Range',
        layerClassname: 'Jensens_Range_USA-PLA',
        map: null,
        layer: 'Sumari Bala',
        startTime: new Date('2026-08-22T01:00:00Z')
      }
    ]);
    await completed.getQueryInterface().bulkDelete(dbLogTableName(completed, 'DBLog_Metadata'), {
      key: EOS_BACKFILL_METADATA_KEY
    });
    const changes: unknown[] = [];
    const resolutions: string[] = [];
    const dbLog = new DbLog(completed, {
      serverID: 1,
      serverName: 'Server',
      onSchemaChange: (change) => changes.push(change),
      resolveMatchMetadata: async ({ layerClassname }) => {
        resolutions.push(layerClassname ?? 'unknown');
        return layerClassname === 'Sumari_Seed_v1'
          ? { map: 'Sumari Bala', layer: 'Sumari Seed v1' }
          : { map: "Jensen's Range", layer: 'Jensen Range USA-PLA' };
      }
    });
    assert.equal(await dbLog.initialize(), 1);
    assert.deepEqual(changes, []);
    assert.deepEqual(resolutions, ['Sumari_Seed_v1', 'Jensens_Range_USA-PLA']);
    assert.equal((await readEosBackfillState(completed)).status, 'complete');

    const matches = (await completed.query('SELECT map, layer FROM DBLog_Matches ORDER BY id', {
      type: QueryTypes.SELECT
    })) as { map: string; layer: string }[];
    assert.deepEqual(matches, [
      { map: 'Sumari Bala', layer: 'Sumari Seed v1' },
      { map: "Jensen's Range", layer: 'Jensen Range USA-PLA' }
    ]);
    const qualityRows = (await completed.query(
      "SELECT id FROM DBLog_Matches WHERE LOWER(map) NOT LIKE '%jensen%'",
      { type: QueryTypes.SELECT }
    )) as { id: number }[];
    assert.deepEqual(
      qualityRows.map(({ id }) => id),
      [1]
    );

    await dbLog.stop();
    const repeated = new DbLog(completed, {
      serverID: 1,
      serverName: 'Server',
      resolveMatchMetadata: async () => {
        throw new Error('completed match repair should not resolve layers again');
      }
    });
    assert.equal(await repeated.initialize(), 1);
    await repeated.stop();
  } finally {
    await completed.close();
  }
});

test('adopts interrupted unversioned structures safely', async () => {
  const interrupted = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await createDbLogSchema(interrupted, { legacy: true });
    await interrupted.getQueryInterface().addColumn('DBLog_Wounds', 'attackerEOSID', {
      type: DataTypes.STRING,
      allowNull: true
    });
    await migrateDbLog(interrupted);
    assert.equal((await readEosBackfillState(interrupted)).status, 'pending');
    const columns = await interrupted.getQueryInterface().describeTable('DBLog_Wounds');
    assert.ok('attackerEOSID' in columns);
    assert.ok('victimEOSID' in columns);
  } finally {
    await interrupted.close();
  }
});
