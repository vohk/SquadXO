import assert from 'node:assert/strict';
import test from 'node:test';
import { DbLogEventBridge, type DbLogWriter } from '../../src/database/event-bridge.js';
import { asEOSID } from '../../src/domain/identity.js';
import type { LivePlayer } from '../../src/domain/server-state.js';

test('maps reduced lifecycle and combat events to core DBLog writes', async () => {
  const calls: { name: string; values: unknown[] }[] = [];
  const method =
    (name: string) =>
    async (...values: unknown[]): Promise<void> => {
      calls.push({ name, values });
    };
  const writer: DbLogWriter = {
    playerConnected: method('playerConnected'),
    startMatch: method('startMatch'),
    endMatch: method('endMatch'),
    tickRate: method('tickRate'),
    wound: method('wound'),
    death: method('death'),
    revive: method('revive')
  };
  const bridge = new DbLogEventBridge(writer);
  const player: LivePlayer = {
    eosID: asEOSID('11111111111111111111111111111111'),
    name: 'Alpha'
  };
  const time = new Date('2026-08-15T12:00:00Z');

  bridge.handle({ name: 'PLAYER_CONNECTED', data: { time, player } });
  bridge.handle(
    {
      name: 'NEW_GAME',
      data: {
        time,
        dlc: 'Game',
        mapClassname: 'Gorodok',
        layerClassname: 'Gorodok_RAAS_v1',
        layer: 'Previous Map'
      }
    },
    { layer: { name: 'Gorodok RAAS v1', map: { name: 'Gorodok' } } }
  );
  bridge.handle({ name: 'TICK_RATE', data: { time, tickRate: 49.5 } });
  bridge.handle({
    name: 'PLAYER_WOUNDED',
    data: { time, victim: player, damage: 12, weapon: 'Rifle', teamkill: false }
  });
  bridge.handle({
    name: 'PLAYER_REVIVED',
    data: { time, victim: player, reviver: player, woundTime: time }
  });
  bridge.handle({
    name: 'ROUND_ENDED',
    data: {
      time,
      winner: { team: 2, faction: 'Blue', subfaction: 'Unit', tickets: 50 },
      loser: { team: 1, faction: 'Red', tickets: 0 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    calls.map((call) => call.name),
    ['playerConnected', 'startMatch', 'tickRate', 'wound', 'revive', 'endMatch']
  );
  assert.deepEqual(calls[1]?.values[0], {
    time,
    dlc: 'Game',
    mapClassname: 'Gorodok',
    layerClassname: 'Gorodok_RAAS_v1',
    map: 'Gorodok',
    layer: 'Gorodok RAAS v1'
  });
  assert.deepEqual(calls[5]?.values[0], {
    time,
    winnerTeam: 2,
    team1Faction: 'Red',
    team1Tickets: 0,
    team2Faction: 'Blue',
    team2Unit: 'Unit',
    team2Tickets: 50
  });
});

test('reports rejected DBLog writes without rejecting event dispatch', async () => {
  const errors: string[] = [];
  const reject = async (): Promise<void> => {
    throw new Error('write failed');
  };
  const writer = Object.fromEntries(
    ['playerConnected', 'startMatch', 'endMatch', 'tickRate', 'wound', 'death', 'revive'].map(
      (name) => [name, reject]
    )
  ) as unknown as DbLogWriter;
  const bridge = new DbLogEventBridge(writer, (error) => errors.push(error.message));

  bridge.handle({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 50 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['write failed']);
});
