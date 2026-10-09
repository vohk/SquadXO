import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalTailReader } from '../../src/logs/local-tail-reader.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for reader output');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('tails from end in order and reads a replacement log from its beginning', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-tail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = join(directory, 'SquadGame.log');
  const old = join(directory, 'SquadGame-old.log');
  await writeFile(active, 'historical\n', 'utf8');
  const lines: string[] = [];
  const replacements: string[] = [];
  const reader = new LocalTailReader({
    path: active,
    pollIntervalMs: 10,
    startAt: 'end',
    onReplacement: (reason) => replacements.push(reason)
  });

  try {
    await reader.start((line) => {
      lines.push(line);
    });
    await appendFile(active, 'first\nsecond\n', 'utf8');
    await waitFor(() => lines.length === 2);
    await rename(active, old);
    await writeFile(active, 'startup\nready\n', 'utf8');
    await waitFor(() => lines.length === 4);
    assert.deepEqual(lines, ['first', 'second', 'startup', 'ready']);
    assert.deepEqual(replacements, ['path-replaced']);
    assert.equal(reader.health().replacements, 1);
  } finally {
    await reader.stop();
  }
});

test('can restart cleanly after its initial log path is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-tail-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = join(directory, 'SquadGame.log');
  const lines: string[] = [];
  const reader = new LocalTailReader({ path: active, startAt: 'beginning', pollIntervalMs: 10 });

  await assert.rejects(
    reader.start((line) => void lines.push(line)),
    /ENOENT/
  );
  assert.equal(reader.health().running, false);

  await writeFile(active, 'available\n', 'utf8');
  try {
    await reader.start((line) => void lines.push(line));
    assert.deepEqual(lines, ['available']);
  } finally {
    await reader.stop();
  }
});

test('copies a bounded snapshot without following later appends', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-log-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = join(directory, 'SquadGame.log');
  const snapshot = join(directory, 'snapshot.log');
  await writeFile(active, 'captured\n', 'utf8');
  const reader = new LocalTailReader({ path: active });

  const result = await reader.copySnapshot(snapshot, { maximumBytes: 1024 });
  await appendFile(active, 'later\n', 'utf8');

  assert.equal(result.sourceBytes, 9);
  assert.equal(await readFile(snapshot, 'utf8'), 'captured\n');
  await assert.rejects(
    reader.copySnapshot(join(directory, 'too-large.log'), { maximumBytes: 2 }),
    /configured maximum/
  );
  await assert.rejects(stat(join(directory, 'too-large.log')), /ENOENT/);
});
