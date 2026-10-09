import assert from 'node:assert/strict';
import test from 'node:test';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { asEOSID, asSteamID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import { SquadRconClient } from '../../src/rcon/client.js';
import type { RconPacket } from '../../src/rcon/codec.js';
import { startRconChatBridge } from '../../src/server/rcon-chat-bridge.js';

const eosID = asEOSID('11111111111111111111111111111111');

test('bridges RCON chat to legacy chat messages and stripped chat commands', () => {
  const state = new ServerState();
  const player = state.upsertPlayer({ eosID, name: 'Alpha', teamID: 1 });
  const rcon = new SquadRconClient({
    host: '127.0.0.1',
    port: 1,
    password: 'unused',
    autoReconnect: false
  });
  const events = new LegacyServerHost({ state, rcon });
  const messages: unknown[] = [];
  const commands: unknown[] = [];
  const facade = events.createFacade('CompatibilityTest');
  facade.on('CHAT_MESSAGE', (message) => messages.push(message));
  facade.on('CHAT_COMMAND:admin', (command) => commands.push(command));
  const stop = startRconChatBridge(rcon, state, events);

  rcon.emit('chat', {
    body: `[ChatAll] [Online IDs:EOS: ${eosID}] Alpha : !admin please help`
  } as RconPacket);

  assert.equal(messages.length, 1);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], {
    raw: `[ChatAll] [Online IDs:EOS: ${eosID}] Alpha : !admin please help`,
    chat: 'ChatAll',
    name: 'Alpha',
    message: 'please help',
    eosID,
    time: (messages[0] as { time: Date }).time,
    player: { ...player, squadID: null, squad: null }
  });

  stop();
  rcon.emit('chat', {
    body: `[ChatAll] [Online IDs:EOS: ${eosID}] Alpha : !admin again`
  } as RconPacket);
  assert.equal(messages.length, 1);
});

test('bridges squad creation, admin camera duration, moderation, and RCON errors', () => {
  const state = new ServerState();
  state.upsertPlayer({ eosID, steamID: '76561198000000001' as never, name: 'Alpha', teamID: 1 });
  const rcon = new SquadRconClient({
    host: '127.0.0.1',
    port: 1,
    password: 'unused',
    autoReconnect: false
  });
  const events = new LegacyServerHost({ state, rcon });
  const facade = events.createFacade('CompatibilityTest');
  const received: Record<string, unknown>[] = [];
  for (const name of [
    'SQUAD_CREATED',
    'POSSESSED_ADMIN_CAMERA',
    'UNPOSSESSED_ADMIN_CAMERA',
    'PLAYER_WARNED',
    'RCON_ERROR'
  ]) {
    facade.on(name, (data) => received.push({ name, data }));
  }
  const stop = startRconChatBridge(rcon, state, events);
  const online = `EOS: ${eosID} steam: 76561198000000001`;

  rcon.emit('chat', {
    body: `Alpha (Online IDs:${online}) has created Squad 3 (Squad Name: Logistics) on Blue Team`
  } as RconPacket);
  rcon.emit('chat', {
    body: `[Online Ids:${online}] Alpha has possessed admin camera.`
  } as RconPacket);
  rcon.emit('chat', {
    body: `[Online IDs:${online}] Alpha has unpossessed admin camera.`
  } as RconPacket);
  rcon.emit('chat', {
    body: 'Remote admin has warned player Alpha. Message was "Stop"'
  } as RconPacket);
  rcon.emit('connectionError', new Error('connection lost'));

  assert.equal(received.length, 5);
  assert.equal((received[0]?.data as { player: { squadID: number } }).player.squadID, 3);
  assert.equal((received[2]?.data as { duration: number }).duration >= 0, true);
  assert.equal((received[3]?.data as { player: { name: string } }).player.name, 'Alpha');
  assert.match(String((received[4]?.data as { error: Error }).error.message), /connection lost/);

  stop();
});

test('refreshes authoritative player state before publishing squad creation', async () => {
  const state = new ServerState();
  const rcon = new SquadRconClient({
    host: '127.0.0.1',
    port: 1,
    password: 'unused',
    autoReconnect: false
  });
  const events = new LegacyServerHost({ state, rcon });
  const facade = events.createFacade('CompatibilityTest');
  let refreshCount = 0;
  let stop = (): void => undefined;
  const received = new Promise<Record<string, unknown>>((resolveEvent, rejectEvent) => {
    facade.on('SQUAD_CREATED', resolveEvent);
    stop = startRconChatBridge(rcon, state, events, {
      refreshPlayers: async () => {
        refreshCount += 1;
        state.replacePlayers([
          {
            playerID: 1,
            eosID,
            steamID: asSteamID('76561198000000001'),
            name: 'Alpha',
            teamID: 2,
            squadID: null,
            isLeader: false,
            role: 'Rifleman'
          }
        ]);
      },
      onError: rejectEvent
    });
    rcon.emit('chat', {
      body: `Alpha (Online IDs:EOS: ${eosID} steam: 76561198000000001) has created Squad 4 (Squad Name: Armor) on Red Team`
    } as RconPacket);
  });

  const event = await received;
  stop();
  assert.equal(refreshCount, 1);
  assert.equal((event.player as { teamID: number }).teamID, 2);
  assert.equal((event.player as { squadID: number }).squadID, 4);
  assert.equal(state.getPlayerByEOSID(eosID)?.squadID, 4);
  facade.dispose();
});
