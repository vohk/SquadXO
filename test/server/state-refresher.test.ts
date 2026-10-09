import assert from 'node:assert/strict';
import test from 'node:test';
import { asEOSID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import { StateRefresher } from '../../src/server/state-refresher.js';

test('refreshes players, squads, layers, and server information', async () => {
  const eosID = asEOSID('11111111111111111111111111111111');
  const layer = {
    level: 'Fallujah',
    layer: 'Fallujah_RAAS_v1',
    team1Faction: 'USA',
    team2Faction: 'INS'
  };
  const state = new ServerState();
  const refresher = new StateRefresher(
    state,
    {
      listPlayers: async () => [
        {
          playerID: 1,
          eosID,
          name: 'Alpha',
          teamID: 1,
          squadID: 1,
          isLeader: false,
          role: 'Rifleman'
        }
      ],
      listSquads: async () => [
        {
          squadID: 1,
          squadName: 'Squad 1',
          size: 1,
          locked: false,
          creatorName: 'Alpha',
          creatorEOSID: eosID,
          teamID: 1,
          teamName: 'USA'
        }
      ],
      showCurrentMap: async () => layer,
      showNextMap: async () => ({ ...layer, layer: 'Fallujah_AAS_v1' }),
      showServerInfo: async () => ({ PlayerCount_I: '1' })
    },
    { playersMs: 100, squadsMs: 100, layersMs: 100, serverInfoMs: 100 }
  );

  refresher.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await refresher.stop();
  const snapshot = state.snapshot();
  assert.equal(snapshot.players[0]?.eosID, eosID);
  assert.equal(snapshot.squads[0]?.creatorEOSID, eosID);
  assert.equal(snapshot.currentLayer?.layer, 'Fallujah_RAAS_v1');
  assert.equal(snapshot.nextLayer?.layer, 'Fallujah_AAS_v1');
  assert.equal(snapshot.serverInfo.a2sPlayerCount, 1);
});

test('initializes complete server state before scheduled refreshes start', async () => {
  const eosID = asEOSID('22222222222222222222222222222222');
  const calls: string[] = [];
  const state = new ServerState();
  const refresher = new StateRefresher(state, {
    listPlayers: async () => {
      calls.push('players');
      return [
        {
          playerID: 2,
          eosID,
          name: 'Bravo',
          teamID: 2,
          squadID: 3,
          isLeader: false,
          role: 'Rifleman'
        }
      ];
    },
    listSquads: async () => {
      calls.push('squads');
      return [];
    },
    showCurrentMap: async () => {
      calls.push('currentLayer');
      return {
        level: 'Gorodok',
        layer: 'Gorodok_RAAS_v1',
        team1Faction: 'CAF',
        team2Faction: 'RGF'
      };
    },
    showNextMap: async () => {
      calls.push('nextLayer');
      return {
        level: 'Narva',
        layer: 'Narva_RAAS_v1',
        team1Faction: 'USA',
        team2Faction: 'RGF'
      };
    },
    showServerInfo: async () => {
      calls.push('serverInfo');
      return { ServerName_s: 'Test Server', PlayerCount_I: '1' };
    }
  });

  await refresher.initialize();

  assert.deepEqual(
    new Set(calls),
    new Set(['players', 'squads', 'currentLayer', 'nextLayer', 'serverInfo'])
  );
  const snapshot = state.snapshot();
  assert.equal(snapshot.players[0]?.eosID, eosID);
  assert.equal(snapshot.currentLayer?.layer, 'Gorodok_RAAS_v1');
  assert.equal(snapshot.serverInfo.serverName, 'Test Server');
  assert.equal(refresher.scheduler.health('players')?.runCount, 0);
});

test('initialization retains the current layer when the next layer is unavailable', async () => {
  const state = new ServerState();
  const refresher = new StateRefresher(state, {
    listPlayers: async () => [],
    listSquads: async () => [],
    showCurrentMap: async () => ({
      level: 'Gorodok',
      layer: 'Gorodok_RAAS_v1',
      team1Faction: 'CAF',
      team2Faction: 'RGF'
    }),
    showNextMap: async () => {
      throw new Error('vote in progress');
    },
    showServerInfo: async () => ({ ServerName_s: 'Test Server' })
  });

  await refresher.initialize();

  assert.equal(state.snapshot().currentLayer?.layer, 'Gorodok_RAAS_v1');
  assert.equal(state.snapshot().nextLayer?.layer, null);
});

test('initialization fails rather than mounting plugins with an unknown current layer', async () => {
  const state = new ServerState();
  const refresher = new StateRefresher(state, {
    listPlayers: async () => [],
    listSquads: async () => [],
    showCurrentMap: async () => {
      throw new Error('current layer unavailable');
    },
    showNextMap: async () => ({
      level: 'Narva',
      layer: 'Narva_RAAS_v1',
      team1Faction: 'USA',
      team2Faction: 'RGF'
    }),
    showServerInfo: async () => ({ ServerName_s: 'Test Server' })
  });

  await assert.rejects(refresher.initialize(), /current layer unavailable/);
});

test('retains a successful current layer when the next layer is unavailable', async () => {
  const current = {
    level: 'JensensRange',
    layer: 'JensensRange_USA-PLA',
    team1Faction: 'USA',
    team2Faction: 'PLA'
  };
  const state = new ServerState();
  let refreshedCurrent: string | null | undefined;
  const refresher = new StateRefresher(
    state,
    {
      listPlayers: async () => [],
      listSquads: async () => [],
      showCurrentMap: async () => current,
      showNextMap: async () => {
        throw new Error('next layer unavailable');
      },
      showServerInfo: async () => ({})
    },
    { playersMs: 100, squadsMs: 100, layersMs: 100, serverInfoMs: 100 },
    { layers: (layer) => void (refreshedCurrent = layer.layer) }
  );

  refresher.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await refresher.stop();

  const snapshot = state.snapshot();
  assert.equal(snapshot.currentLayer?.layer, 'JensensRange_USA-PLA');
  assert.equal(snapshot.nextLayer?.layer, null);
  assert.equal(refreshedCurrent, 'JensensRange_USA-PLA');
  assert.equal(refresher.scheduler.health('layers')?.failureCount, 1);
});

test('shares an authoritative player refresh already in progress', async () => {
  const state = new ServerState();
  let listCalls = 0;
  let releaseList = (): void => undefined;
  const listReady = new Promise<void>((resolveList) => {
    releaseList = resolveList;
  });
  let hookCalls = 0;
  const refresher = new StateRefresher(
    state,
    {
      listPlayers: async () => {
        listCalls += 1;
        await listReady;
        return [];
      },
      listSquads: async () => [],
      showCurrentMap: async () => ({
        level: null,
        layer: null,
        team1Faction: null,
        team2Faction: null
      }),
      showNextMap: async () => ({
        level: null,
        layer: null,
        team1Faction: null,
        team2Faction: null
      }),
      showServerInfo: async () => ({})
    },
    {},
    { players: () => void (hookCalls += 1) }
  );

  const first = refresher.refreshPlayers();
  const second = refresher.refreshPlayers();
  assert.equal(first, second);
  releaseList();
  await Promise.all([first, second]);

  assert.equal(listCalls, 1);
  assert.equal(hookCalls, 1);
});
