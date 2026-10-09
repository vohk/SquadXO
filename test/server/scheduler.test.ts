import assert from 'node:assert/strict';
import test from 'node:test';
import { NonOverlappingScheduler } from '../../src/server/scheduler.js';

test('scheduled tasks never overlap and stop cleanly', async () => {
  const scheduler = new NonOverlappingScheduler();
  let active = 0;
  let maximumActive = 0;
  scheduler.add('slow', 1, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
  });

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await scheduler.stop();

  assert.equal(maximumActive, 1);
  assert.ok((scheduler.health('slow')?.runCount ?? 0) >= 2);
  assert.equal(scheduler.health('slow')?.running, false);
});
