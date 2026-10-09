import assert from 'node:assert/strict';
import test from 'node:test';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { createLegacyStateRefreshHooks } from '../../src/compatibility/state-refresh-hooks.js';
import { asEOSID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import { SquadRconClient } from '../../src/rcon/client.js';

test('routes refreshed state through the complete legacy compatibility contract', async () => {
  const eosID = asEOSID('11111111111111111111111111111111');
  const state = new ServerState();
  state.upsertPlayer({ eosID, name: 'Alpha', teamID: 1, squadID: 1 });
  const rcon = new SquadRconClient({
    host: '127.0.0.1',
    port: 1,
    password: 'unused',
    autoReconnect: false
  });
  const events = new LegacyServerHost({ state, rcon });
  const facade = events.createFacade('CompatibilityTest');
  const received: { readonly name: string; readonly data: unknown }[] = [];
  for (const name of [
    'PLAYER_TEAM_CHANGE',
    'PLAYER_SQUAD_CHANGE',
    'UPDATED_PLAYER_INFORMATION',
    'UPDATED_SQUAD_INFORMATION',
    'UPDATED_LAYER_INFORMATION',
    'UPDATED_A2S_INFORMATION',
    'UPDATED_SERVER_INFORMATION'
  ]) {
    facade.on(name, (data) => received.push({ name, data }));
  }
  const hooks = createLegacyStateRefreshHooks(events, {
    async byInformation(information) {
      const name = information.layer ?? information.level;
      return name ? { name, classname: name, map: { name } } : undefined;
    }
  });

  hooks.players?.(
    state.replacePlayers([
      {
        playerID: 1,
        eosID,
        name: 'Alpha',
        teamID: 2,
        squadID: 3,
        isLeader: false,
        role: 'Rifleman'
      }
    ])
  );
  hooks.squads?.();
  await hooks.layers?.(
    {
      level: 'Fallujah',
      layer: 'Fallujah_RAAS_v1',
      team1Faction: 'USA',
      team2Faction: 'INS'
    },
    {
      level: 'Narva',
      layer: 'Narva_AAS_v1',
      team1Faction: 'USA',
      team2Faction: 'RUS'
    }
  );
  const serverInfo = {
    playerCount: 100,
    a2sPlayerCount: 100,
    publicQueue: 4,
    reserveQueue: 1
  };
  state.setServerInfo(serverInfo);
  hooks.serverInfo?.(serverInfo);

  assert.deepEqual(
    received.map((event) => event.name),
    [
      'PLAYER_TEAM_CHANGE',
      'PLAYER_SQUAD_CHANGE',
      'UPDATED_PLAYER_INFORMATION',
      'UPDATED_SQUAD_INFORMATION',
      'UPDATED_LAYER_INFORMATION',
      'UPDATED_A2S_INFORMATION',
      'UPDATED_SERVER_INFORMATION'
    ]
  );
  assert.equal(facade.currentLayer?.name, 'Fallujah_RAAS_v1');
  assert.equal(facade.nextLayer?.name, 'Narva_AAS_v1');
  assert.equal(facade.playerCount, 100);
  assert.equal(facade.a2sPlayerCount, 100);
  assert.equal((received[0]?.data as { oldTeamID?: number }).oldTeamID, 1);
  assert.equal((received[0]?.data as { newTeamID?: number }).newTeamID, 2);
  assert.equal((received[1]?.data as { oldSquadID?: number }).oldSquadID, 1);
  assert.equal((received[1]?.data as { newSquadID?: number }).newSquadID, 3);
  assert.deepEqual(received[5]?.data, received[6]?.data);
});
