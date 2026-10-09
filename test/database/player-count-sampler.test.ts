import assert from 'node:assert/strict';
import test from 'node:test';
import { samplePlayerCount } from '../../src/database/player-count-sampler.js';

test('persists normalized RCON player and queue counts', async () => {
  const calls: unknown[][] = [];
  const writer = {
    async playerCount(...values: unknown[]): Promise<void> {
      calls.push(values);
    }
  };
  const time = new Date('2026-08-20T12:00:00Z');

  assert.equal(await samplePlayerCount(writer, {}, time), false);
  assert.equal(
    await samplePlayerCount(writer, { a2sPlayerCount: 87, publicQueue: 5, reserveQueue: 1 }, time),
    true
  );
  assert.deepEqual(calls, [[time, 87, 5, 1]]);
});
