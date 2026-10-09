import { captureLines, markerLines, deployableLines } from '../logs/fixtures/patch-log.js';
import { playersResponse, squadsResponse } from '../rcon/fixtures/patch-rcon.js';
import { parsePlayerList, parseSquadList } from '../../src/rcon/squad-protocol.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { asEOSID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import { SquadLogParser } from '../../src/logs/parser.js';
import { AdminCommands } from '../../src/server/admin-commands.js';
import { OrderedStateDispatcher, ServerStateReducer } from '../../src/server/state-reducer.js';

const eosID = asEOSID('11111111111111111111111111111111');
const secondEOSID = asEOSID('22222222222222222222222222222222');
const prefix = '[2026.08.15-12.34.56:789][ 42]';

test('carries an EOS-only player through connect, state, action, combat, and disconnect', async () => {
  const state = new ServerState();
  const dispatcher = new OrderedStateDispatcher(new ServerStateReducer(state));
  const parser = new SquadLogParser();
  let stateWasReadyWhenPublished = false;
  dispatcher.on('PLAYER_CONNECTED', () => {
    stateWasReadyWhenPublished = state.getPlayerByEOSID(eosID)?.name === 'Alpha';
  });

  const lines = [
    `${prefix}LogNet: Join request: /Game?Name=Alpha?SplitscreenCount=1`,
    `${prefix}LogNet: Login request: ?Name=Alpha userId: RedpointEOS:${eosID} platform: RedpointEOS`,
    `${prefix}LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/PersistentLevel.AlphaController (IP: 127.0.0.1 | Online IDs:EOS: ${eosID})`,
    `${prefix}LogNet: Join succeeded: Alpha`
  ];
  for (const [index, line] of lines.entries()) {
    if (index === 3) {
      state.replacePlayers([
        {
          playerID: 1,
          eosID,
          name: 'Alpha',
          teamID: 1,
          squadID: 1,
          isLeader: false,
          role: 'Rifleman'
        }
      ]);
    }
    for (const event of parser.parseLine(line)) dispatcher.process(event);
  }

  const connected = state.getPlayerByEOSID(eosID);
  assert.equal(connected?.steamID, undefined);
  assert.equal(connected?.suffix, 'Alpha');
  assert.equal(stateWasReadyWhenPublished, true);

  const warned: string[] = [];
  const admin = new AdminCommands({
    warn: async (target, message) => void warned.push(`${target}:${message}`),
    kick: async () => undefined,
    forceTeamChange: async () => undefined
  });
  await admin.warn(connected!, 'test warning');
  assert.deepEqual(warned, [`${eosID}:test warning`]);

  const combat = dispatcher.process({
    name: 'PLAYER_DAMAGED',
    data: { attackerEOSID: eosID, victimName: 'Alpha', damage: 1 }
  });
  assert.equal((combat[0]?.data.attacker as { eosID?: string } | undefined)?.eosID, eosID);
  assert.equal((combat[0]?.data.victim as { eosID?: string } | undefined)?.eosID, eosID);

  dispatcher.process({ name: 'PLAYER_DISCONNECTED', data: { eosID } });
  assert.equal(state.getPlayerByEOSID(eosID), undefined);
});

test('enriches legacy possess and deployable events with resolved players', () => {
  const state = new ServerState();
  const reducer = new ServerStateReducer(state);
  state.upsertPlayer({ eosID, name: 'Alpha', suffix: 'AlphaSuffix', teamID: 1 });

  const possess = reducer.reduce({
    name: 'PLAYER_POSSESS',
    data: { playerEOSID: eosID, playerSuffix: 'AlphaSuffix', possessClassname: 'Rifleman' }
  });
  assert.equal((possess[0]?.data.player as { name?: string }).name, 'Alpha');
  assert.equal(
    (possess[0]?.data.player as { possessClassname?: string }).possessClassname,
    'Rifleman'
  );
  assert.equal(possess[0]?.data.playerSuffix, undefined);

  const deployable = reducer.reduce({
    name: 'DEPLOYABLE_DAMAGED',
    data: { playerSuffix: 'AlphaSuffix', deployable: 'FOBRadio', damage: 10 }
  });
  assert.equal((deployable[0]?.data.player as { eosID?: string }).eosID, eosID);
  assert.equal(deployable[0]?.data.playerSuffix, undefined);
});

test('merges authoritative RCON snapshots by EOS ID and reports actual changes', () => {
  const state = new ServerState();
  state.upsertPlayer({ eosID, name: 'Alpha', controller: 'Controller' });

  const first = state.replacePlayers([
    {
      playerID: 7,
      eosID,
      name: 'Alpha',
      teamID: 1,
      squadID: 2,
      isLeader: true,
      role: 'Rifleman'
    }
  ]);
  assert.equal(first.connected.length, 0);
  assert.equal(first.teamChanged.length, 1);
  assert.equal(state.getPlayerByController('Controller')?.playerID, 7);

  const second = state.replacePlayers([
    {
      playerID: 7,
      eosID,
      name: 'Alpha',
      teamID: null,
      squadID: null,
      isLeader: false,
      role: 'Recruit'
    }
  ]);
  assert.equal(second.teamChanged[0]?.oldTeamID, 1);
  assert.equal(state.getPlayerByEOSID(eosID)?.teamID, undefined);
  assert.equal(state.getPlayerByName('alpha')?.eosID, eosID);
});

test('retains departed players long enough to enrich delayed disconnect logs', () => {
  let now = 1_000;
  const state = new ServerState({ departedPlayerTtlMs: 120_000, now: () => now });
  const reducer = new ServerStateReducer(state);
  state.upsertPlayer({ eosID, name: 'Alpha', teamID: 1 });

  const changes = state.replacePlayers([]);
  assert.equal(changes.disconnected[0]?.name, 'Alpha');
  const delayed = reducer.reduce({
    name: 'PLAYER_DISCONNECTED',
    data: { eosID, time: new Date() }
  });
  assert.equal((delayed[0]?.data.player as { name?: string } | undefined)?.name, 'Alpha');

  now += 120_001;
  const expired = reducer.reduce({
    name: 'PLAYER_DISCONNECTED',
    data: { eosID, time: new Date() }
  });
  assert.equal(expired[0]?.data.player, undefined);
});

test('classifies combat events as teamkills from resolved player teams', () => {
  const state = new ServerState();
  const reducer = new ServerStateReducer(state);
  state.upsertPlayer({
    eosID,
    name: 'Alpha',
    teamID: 1,
    controller: 'BP_PlayerController_C_1'
  });
  state.upsertPlayer({ eosID: secondEOSID, name: 'Bravo', teamID: 1 });

  const sameTeam = reducer.reduce({
    name: 'PLAYER_WOUNDED',
    data: {
      attackerEOSID: eosID,
      victimName: 'Bravo'
    }
  });
  assert.equal(sameTeam[0]?.data.teamkill, true);

  const selfDamage = reducer.reduce({
    name: 'PLAYER_DAMAGED',
    data: { attackerEOSID: eosID, victimName: 'Alpha' }
  });
  assert.equal(selfDamage[0]?.data.teamkill, false);

  state.upsertPlayer({ eosID: secondEOSID, name: 'Bravo', teamID: 2 });
  const enemyKill = reducer.reduce({
    name: 'PLAYER_DIED',
    data: { attackerEOSID: eosID, victimName: 'Bravo' }
  });
  assert.equal(enemyKill[0]?.data.teamkill, false);
});

test('falls back to the attacker controller when combat logs omit a usable EOS ID', () => {
  const state = new ServerState();
  const reducer = new ServerStateReducer(state);
  state.upsertPlayer({
    eosID,
    name: 'Alpha',
    teamID: 1,
    controller: 'BP_PlayerController_C_1'
  });
  state.upsertPlayer({ eosID: secondEOSID, name: 'Bravo', teamID: 1 });

  const combat = reducer.reduce({
    name: 'PLAYER_WOUNDED',
    data: {
      attackerPlayerController: 'BP_PlayerController_C_1',
      victimName: 'Bravo'
    }
  });

  assert.equal((combat[0]?.data.attacker as { eosID?: string } | undefined)?.eosID, eosID);
  assert.equal(combat[0]?.data.teamkill, true);
});

test('retains captured party, vehicle and team-ticket fields in authoritative snapshots', () => {
  const state = new ServerState();
  const players = parsePlayerList(playersResponse);
  const squads = parseSquadList(squadsResponse);
  state.replacePlayers(players);
  state.replaceSquads(squads);
  const snapshot = state.snapshot();
  assert.deepEqual(
    snapshot.players.map((player) => player.partyID),
    [0, null, null, null, 0]
  );
  assert.ok(snapshot.players.every((player) => player.vehicle === null));
  assert.deepEqual(
    snapshot.squads.map((squad) => squad.teamTickets),
    [100, 100]
  );
  const player = players[0];
  assert.ok(player);
  state.upsertPlayer({ ...state.getPlayerByEOSID(player.eosID)!, controller: 'Controller' });
  const legacy = playersResponse
    .replaceAll(/ \| Party ID: (?:#\d+|N\/A)/g, '')
    .replaceAll(' | Vehicle: N/A', '');
  state.replacePlayers(parsePlayerList(legacy));
  const updated = state.getPlayerByEOSID(player.eosID);
  assert.ok(updated);
  assert.equal('partyID' in updated, false);
  assert.equal('vehicle' in updated, false);
  assert.equal(updated.controller, 'Controller');
});

test('dispatches captured objective, marker and deployable events without losing normalized data', () => {
  const parser = new SquadLogParser();
  const dispatcher = new OrderedStateDispatcher(new ServerStateReducer(new ServerState()));
  for (const line of [...captureLines, ...markerLines, ...deployableLines]) {
    const [parsed] = parser.parseLine(line);
    assert.ok(parsed);
    let emitted: unknown;
    dispatcher.once(parsed.name, (data: unknown) => {
      emitted = data;
    });
    const reduced = dispatcher.process(parsed);
    assert.deepEqual(reduced, [parsed]);
    assert.deepEqual(emitted, parsed.data);
  }
});
