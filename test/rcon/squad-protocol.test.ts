import { playersResponse, squadsResponse, partiesResponse } from './fixtures/patch-rcon.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCurrentLayer,
  parseChatMessage,
  parseRconBroadcast,
  normalizeServerInformation,
  parseNextLayer,
  parsePlayerList,
  parsePartyList,
  parseServerInfo,
  parseSquadList
} from '../../src/rcon/squad-protocol.js';

const eosOne = '11111111111111111111111111111111';
const eosTwo = '22222222222222222222222222222222';

test('parses EOS-first players including an EOS-only player', () => {
  const response = [
    `ID: 4 | Online IDs:EOS: ${eosOne} steam: 76561198000000001 | Name: Alpha | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: Rifleman`,
    `ID: 5 | Online IDs:EOS: ${eosTwo} | Name: Bravo | Team ID: N/A | Squad ID: N/A | Is Leader: False | Role: Recruit`
  ].join('\n');
  const players = parsePlayerList(response);

  assert.equal(players.length, 2);
  assert.equal(players[0]?.steamID, '76561198000000001');
  assert.equal(players[1]?.eosID, eosTwo);
  assert.equal(players[1]?.steamID, undefined);
  assert.equal(players[1]?.teamID, null);
});

test('parses EOS-first chat messages with and without Steam IDs', () => {
  const time = new Date('2026-08-20T12:00:00Z');
  assert.deepEqual(
    parseChatMessage(
      `[ChatAll] [Online IDs:EOS: ${eosOne} steam: 76561198000000001] Alpha : !admin help`,
      time
    ),
    {
      raw: `[ChatAll] [Online IDs:EOS: ${eosOne} steam: 76561198000000001] Alpha : !admin help`,
      chat: 'ChatAll',
      name: 'Alpha',
      message: '!admin help',
      eosID: eosOne,
      steamID: '76561198000000001',
      time
    }
  );
  assert.equal(
    parseChatMessage(`[ChatSquad] [Online IDs:EOS: ${eosTwo}] Bravo : !switch now`, time)?.message,
    '!switch now'
  );
  assert.equal(parseChatMessage('not a chat packet', time), undefined);
});

test('parses legacy Squad RCON broadcasts', () => {
  const time = new Date('2026-08-20T12:00:00Z');
  const online = `EOS: ${eosOne} steam: 76561198000000001`;
  assert.equal(
    parseRconBroadcast(
      `Alpha (Online IDs:${online}) has created Squad 3 (Squad Name: Logistics) on Blue Team`,
      time
    )?.name,
    'SQUAD_CREATED'
  );
  assert.deepEqual(
    parseRconBroadcast(`[Online Ids:${online}] Alpha has possessed admin camera.`, time),
    {
      name: 'POSSESSED_ADMIN_CAMERA',
      data: {
        raw: `[Online Ids:${online}] Alpha has possessed admin camera.`,
        name: 'Alpha',
        eosID: eosOne,
        steamID: '76561198000000001',
        time
      }
    }
  );
  assert.equal(
    parseRconBroadcast(`Kicked player 4. [Online IDs=${online}] Alpha`, time)?.name,
    'PLAYER_KICKED'
  );
  assert.equal(
    parseRconBroadcast(`Banned player 4. [Online IDs=${online}] Alpha for interval 1d`, time)?.name,
    'PLAYER_BANNED'
  );
  assert.equal(
    parseRconBroadcast('Remote admin has warned player Alpha. Message was "Stop"', time)?.name,
    'PLAYER_WARNED'
  );
});

test('parses squads, layer responses, and server JSON', () => {
  const squads = parseSquadList(
    [
      'Team ID: 1 (Blue Team)',
      `ID: 3 | Name: Logistics | Size: 4 | Locked: False | Creator Name: Alpha | Creator Online IDs:EOS: ${eosOne} steam: 76561198000000001 |`
    ].join('\n')
  );
  assert.equal(squads[0]?.creatorEOSID, eosOne);
  assert.equal(squads[0]?.teamName, 'Blue Team');

  assert.deepEqual(
    parseCurrentLayer('Current level is Fallujah, layer is Fallujah_RAAS_v1, factions USA INS'),
    {
      level: 'Fallujah',
      layer: 'Fallujah_RAAS_v1',
      team1Faction: 'USA',
      team2Faction: 'INS'
    }
  );
  assert.equal(
    parseNextLayer('Next level is Fallujah, layer is To be voted, factions  ').layer,
    null
  );
  assert.deepEqual(parseServerInfo('{"MaxPlayers":100}'), { MaxPlayers: 100 });
});

test('normalizes ShowServerInfo without relying on A2S', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const information = normalizeServerInformation(
    {
      ServerName_s: 'Test Server',
      MaxPlayers: '100',
      PlayerReserveCount_I: '2',
      PlayerCount_I: '87',
      PublicQueue_I: '5',
      ReservedQueue_I: '1',
      MapName_s: 'Fallujah_RAAS_v1',
      NextLayer_s: 'Narva_AAS_v1',
      TeamOne_s: 'Fallujah_RAAS_v1 USA',
      TeamTwo_s: 'Fallujah_RAAS_v1 INS',
      PLAYTIME_I: '120',
      GameVersion_s: 'test-version'
    },
    now
  );

  assert.equal(information.a2sPlayerCount, 87);
  assert.equal(information.playerCount, 87);
  assert.equal(information.publicQueue, 5);
  assert.equal(information.reserveQueue, 1);
  assert.equal(information.publicSlots, 98);
  assert.equal(information.teamOne, ' USA');
  assert.equal((information.matchStartTime as Date).toISOString(), '2026-08-20T11:58:00.000Z');
});

test('parses captured player party fields without swallowing vehicle into role', () => {
  const players = parsePlayerList(playersResponse);
  assert.equal(players.length, 5);
  assert.deepEqual(
    players.map((player) => player.partyID),
    [0, null, null, null, 0]
  );
  assert.ok(players.every((player) => player.vehicle === null));
  assert.deepEqual(
    players.map((player) => player.role),
    ['MEI_SL_01', 'MEI_Rifleman_01', 'MEI_Recruit', 'WPMC_SL_01', 'MEI_Rifleman_01']
  );
  assert.deepEqual(
    players.map((player) => player.teamID),
    [2, 2, 2, 1, 2]
  );
  assert.deepEqual(
    players.map((player) => player.squadID),
    [2, null, null, 1, 2]
  );
  const legacy = parsePlayerList(
    `ID: 1 | Online IDs:EOS: ${eosOne} | Name: Legacy | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: Rifleman`
  )[0];
  assert.ok(legacy);
  assert.equal('partyID' in legacy, false);
  assert.equal('vehicle' in legacy, false);
});

test('parses captured ticket headers and clears context at an unrecognized team header', () => {
  const squads = parseSquadList(squadsResponse);
  assert.equal(squads.length, 2);
  assert.deepEqual(
    squads.map((squad) => squad.teamID),
    [1, 2]
  );
  assert.deepEqual(
    squads.map((squad) => squad.teamTickets),
    [100, 100]
  );
  assert.deepEqual(
    squads.map((squad) => squad.size),
    [1, 2]
  );
  const broken = squadsResponse.replace(
    'Team ID: 2 (Irregular Battle Group) - Tickets: 100',
    'Team ID: 2 (Irregular Battle Group) - Tickets: unknown'
  );
  assert.deepEqual(
    parseSquadList(broken).map((squad) => squad.teamID),
    [1]
  );
  const legacy = squadsResponse.replaceAll(' - Tickets: 100', '');
  assert.deepEqual(
    parseSquadList(legacy).map((squad) => squad.teamID),
    [1, 2]
  );
  assert.ok(parseSquadList(legacy).every((squad) => !('teamTickets' in squad)));
});

test('parses captured populated parties and No Party groups consistently with ListPlayers', () => {
  const parties = parsePartyList(partiesResponse);
  assert.deepEqual(
    parties.map(({ teamID, partyID, players }) => ({ teamID, partyID, count: players.length })),
    [
      { teamID: 1, partyID: null, count: 1 },
      { teamID: 2, partyID: 0, count: 2 },
      { teamID: 2, partyID: null, count: 2 }
    ]
  );
  const players = parsePlayerList(playersResponse);
  for (const member of parties.flatMap((party) => party.players)) {
    const expected = players.find((player) => player.playerID === member.playerID);
    assert.ok(expected);
    const { vehicle, ...withoutVehicle } = expected;
    assert.equal(vehicle, null);
    assert.deepEqual(member, withoutVehicle);
  }
  assert.equal(parsePartyList('----- Active Parties -----').length, 0);
});

test('party rows cannot inherit context from unrecognized team or party headers', () => {
  const brokenTeam = partiesResponse.replace('Team 2', 'Team unknown');
  assert.equal(parsePartyList(brokenTeam).flatMap((party) => party.players).length, 1);
  const brokenParty = partiesResponse.replace('Party #0', 'Party #unknown');
  assert.equal(parsePartyList(brokenParty).flatMap((party) => party.players).length, 3);
});

test('malformed or duplicate active rows reject the entire roster', () => {
  const row = `ID: 4 | Online IDs:EOS: ${eosOne} | Name: Alpha | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: Rifleman`;
  for (const response of [
    '',
    'unrecognized response',
    `${row}\nID: malformed`,
    `${row}\n${row}`,
    `${row}\nnew unrecognized active row`
  ]) {
    assert.throws(() => parsePlayerList(response));
  }
  assert.deepEqual(
    parsePlayerList(
      '----- Active Players -----\n----- Recently Disconnected Players -----\nID: malformed disconnected'
    ),
    []
  );
});
