import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { replayLog } from '../../src/logs/replay.js';

test('replays lines in order and reports unmatched input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'fixture.log');
  await writeFile(fixture, 'ignored\nEVENT one\nEVENT two\n', 'utf8');

  const summary = await replayLog(fixture, [
    {
      name: 'EVENT',
      match: (line) => (line.startsWith('EVENT ') ? { name: 'EVENT' } : undefined)
    }
  ]);

  assert.equal(summary.totalLines, 3);
  assert.equal(summary.matchedLines, 2);
  assert.equal(summary.unmatchedLines, 1);
  assert.deepEqual(summary.eventCounts, { EVENT: 2 });
});

test('supports the Milestone 1 no-op parser', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'fixture.log');
  await writeFile(fixture, 'one\ntwo\n', 'utf8');

  const summary = await replayLog(fixture);
  assert.deepEqual(
    { total: summary.totalLines, matched: summary.matchedLines, unmatched: summary.unmatchedLines },
    { total: 2, matched: 0, unmatched: 2 }
  );
});
