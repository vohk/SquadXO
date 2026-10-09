import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteTail } from '../../src/logs/sftp-tail.js';

class MemoryTail extends RemoteTail {
  contents = Buffer.alloc(0);
  connects = 0;
  disconnects = 0;

  protected connect(): Promise<void> {
    this.connects += 1;
    return Promise.resolve();
  }

  protected disconnect(): Promise<void> {
    this.disconnects += 1;
    return Promise.resolve();
  }

  protected getSize(): Promise<number> {
    return Promise.resolve(this.contents.length);
  }

  protected read(_remotePath: string, start: number, end: number): Promise<Buffer> {
    return Promise.resolve(this.contents.subarray(start, end + 1));
  }
}

test('remote tail preserves partial lines and detects log replacement', async () => {
  const tail = new MemoryTail({ fetchInterval: 5, maximumReadSize: 1024 });
  const lines: string[] = [];
  let replacements = 0;
  tail.on('line', (line: string) => lines.push(line));
  tail.on('replacement', () => {
    replacements += 1;
  });

  tail.contents = Buffer.from('first\npartial');
  await tail.watch('/logs/SquadGame.log');
  assert.deepEqual(lines, ['first']);

  tail.contents = Buffer.from('first\npartial line\n');
  await waitFor(() => lines.length === 2);
  assert.deepEqual(lines, ['first', 'partial line']);

  tail.contents = Buffer.from('new\n');
  await waitFor(() => replacements === 1 && lines.length === 3);
  assert.deepEqual(lines, ['first', 'partial line', 'new']);

  await tail.unwatch();
  assert.equal(tail.connects, 1);
  assert.equal(tail.disconnects, 1);
});

test('remote tail applies backpressure while an asynchronous line handler is busy', async () => {
  const tail = new MemoryTail({ fetchInterval: 5, maximumReadSize: 1024 });
  const lines: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let reportFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    reportFirstStarted = resolve;
  });
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let activeHandlers = 0;
  let maximumActiveHandlers = 0;

  tail.setLineHandler(async (line) => {
    activeHandlers += 1;
    maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
    lines.push(line);
    if (line === 'first') {
      reportFirstStarted?.();
      await firstBlocked;
    }
    activeHandlers -= 1;
  });
  tail.contents = Buffer.from('first\nsecond\n');

  const watching = tail.watch('/logs/SquadGame.log');
  await firstStarted;
  assert.deepEqual(lines, ['first']);
  assert.equal(maximumActiveHandlers, 1);

  releaseFirst?.();
  await watching;
  assert.deepEqual(lines, ['first', 'second']);
  assert.equal(maximumActiveHandlers, 1);

  await tail.unwatch();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for remote tail');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}
