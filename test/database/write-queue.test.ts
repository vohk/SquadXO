import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseWriteQueue } from '../../src/database/write-queue.js';

test('serializes DBLog writes, bounds backlog, and reports operation failures', async () => {
  const reported: string[] = [];
  const queue = new DatabaseWriteQueue({
    maximumPending: 2,
    onError: (error) => reported.push(error.message)
  });
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(async () => blocker);
  const second = queue.enqueue(async () => {
    throw new Error('database unavailable');
  });
  await assert.rejects(
    queue.enqueue(async () => undefined),
    /queue is full/
  );
  assert.equal(queue.highWaterMark, 2);
  assert.equal(queue.rejected, 1);
  release?.();
  await first;
  await assert.rejects(second, /database unavailable/);
  await queue.drain();
  assert.deepEqual(reported, ['database unavailable']);
  assert.equal(queue.pending, 0);
  assert.equal(queue.highWaterMark, 2);
  assert.equal(queue.rejected, 1);
});
