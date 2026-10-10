import assert from 'node:assert/strict';
import {
  type FileHandle,
  mkdtemp,
  readdir,
  readFile,
  rm,
  open,
  stat,
  writeFile,
  utimes,
  unlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  RecorderStore,
  type RecorderStorageOptions
} from '../../src/plugins/builtin/rcon-recorder-store.js';

function options(
  directory: string,
  changes: Partial<RecorderStorageOptions> = {}
): RecorderStorageOptions {
  return {
    directory,
    retentionDays: 14,
    maxTotalMB: 1,
    maxFileMB: 0.1,
    maxBufferMB: 0.1,
    maxEntryKB: 4,
    maxDedupEntries: 2,
    compress: true,
    ...changes
  };
}
async function records(directory: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.jsonl') && !name.endsWith('.gz')) continue;
    const buffer = await readFile(join(directory, name));
    const text = name.endsWith('.gz')
      ? gunzipSync(buffer).toString('utf8')
      : buffer.toString('utf8');
    result.push(
      ...text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    );
  }
  return result;
}

export { records };

test('rotates by completion hour, never reopens old files, and resets bounded deduplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-recorder-'));
  const errors: unknown[] = [];
  const store = new RecorderStore(options(directory), (error) => errors.push(error));
  try {
    await store.start();
    const time = new Date();
    time.setUTCMinutes(59, 59, 0);
    const entry = { type: 'command', command: 'ListPlayers', response: 'EOS-only roster' };
    store.enqueue(entry, time, { command: 'a', response: 'one' });
    store.enqueue(entry, time, { command: 'a', response: 'one' });
    store.enqueue(entry, time, { command: 'b', response: 'two' });
    store.enqueue(entry, time, { command: 'c', response: 'three' });
    store.enqueue(entry, time, { command: 'a', response: 'one' }); // a evicted from a 2-entry cache
    await store.idle();
    const next = new Date(time.getTime() + 2000);
    store.enqueue(entry, next, { command: 'a', response: 'one' });
    await store.idle();
    store.enqueue(entry, time, { command: 'a', response: 'one' }); // backwards clock: new unique file
    await store.stop();
    const names = await readdir(directory);
    assert.equal(names.length, 3);
    assert.ok(names.every((name) => name.endsWith('.gz')));
    const all = await records(directory);
    assert.equal(all.length, 7);
    assert.equal(all.filter((item) => item.same === true).length, 1);
    assert.equal(all.filter((item) => item.response === 'EOS-only roster').length, 6);
    assert.deepEqual(errors, []);
    assert.equal(store.enqueue(entry, next), false);
    assert.equal((await readdir(directory)).length, 3);
  } finally {
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('counts active bytes, rotates by size, and skips gzip when source plus scratch exceeds cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-recorder-cap-'));
  const configuration = options(directory, { maxTotalMB: 0.004, maxFileMB: 0.004, maxEntryKB: 3 });
  const store = new RecorderStore(configuration, (error) => {
    throw error;
  });
  try {
    await store.start();
    for (let index = 0; index < 5; index++) {
      assert.equal(store.enqueue({ sequence: index, body: 'x'.repeat(2800) }, new Date()), true);
      await store.idle();
      const names = await readdir(directory);
      const sizes = await Promise.all(names.map((name) => stat(join(directory, name))));
      assert.ok(
        sizes.reduce((sum, info) => sum + info.size, 0) <= configuration.maxTotalMB * 1024 * 1024
      );
      assert.ok(sizes.every((info) => info.size <= configuration.maxFileMB * 1024 * 1024));
    }
    await store.stop();
    assert.equal(store.stats.written, 5);
    assert.equal(store.stats.dropped, 0);
    const names = await readdir(directory);
    assert.equal(names.length, 1); // old files pruned even with an active file in accounting
    assert.ok(names[0]!.endsWith('.jsonl')); // compression needs more than the remaining budget
    assert.equal((await records(directory))[0]?.sequence, 4);
  } finally {
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('slow disk has a bounded queue; stop drains accepted work and rejects late entries', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-recorder-buffer-'));
  const handle = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const original = prototype.writeFile;
  await handle.close();
  await unlink(join(directory, 'probe'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = false;
  context.mock.method(
    prototype,
    'writeFile',
    async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
      writing = true;
      await gate;
      return original.apply(this, args);
    }
  );
  const store = new RecorderStore(
    options(directory, { maxBufferMB: 0.001, maxEntryKB: 1, compress: false }),
    () => undefined
  );
  try {
    await store.start();
    assert.equal(store.enqueue({ body: 'first'.repeat(60) }, new Date()), true);
    while (!writing) await new Promise((resolve) => setImmediate(resolve));
    for (let index = 0; index < 20; index++) store.enqueue({ body: 'next'.repeat(70) }, new Date());
    assert.ok(store.stats.overflow >= 18);
    let stopped = false;
    const stop = store.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(store.enqueue({ body: 'late' }, new Date()), false);
    release();
    await stop;
    assert.equal(store.stats.written + store.stats.dropped, 21);
    const before = await records(directory);
    await store.maintain();
    assert.deepEqual(await records(directory), before);
  } finally {
    release();
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('write errors are observable and later entries retry without leaving partial JSON', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-recorder-errors-'));
  const handle = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const original = prototype.writeFile;
  await handle.close();
  await unlink(join(directory, 'probe'));
  let fail = true;
  context.mock.method(
    prototype,
    'writeFile',
    async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
      if (fail) {
        fail = false;
        await original.call(this, '{partial');
        throw new Error('ENOSPC fixture');
      }
      return original.apply(this, args);
    }
  );
  const errors: unknown[] = [];
  const store = new RecorderStore(options(directory, { compress: false }), (error) =>
    errors.push(error)
  );
  try {
    await store.start();
    store.enqueue({ body: 'lost' }, new Date());
    await store.idle();
    store.enqueue({ body: 'retry' }, new Date());
    await store.stop();
    assert.equal(store.stats.ioErrors, 1);
    assert.equal(store.stats.dropped, 1);
    assert.equal(errors.length, 1);
    assert.deepEqual(await records(directory), [{ body: 'retry' }]);
  } finally {
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup removes aged owned files and crash scratch, keeps unrelated files, and enforces one instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-recorder-start-'));
  const name = 'rcon-2020-01-01T00-00000000-0000-0000-0000-000000000000.jsonl';
  await writeFile(join(directory, name), '{"old":true}\n');
  await utimes(join(directory, name), new Date(0), new Date(0));
  await writeFile(join(directory, `${name}.gz.tmp`), 'interrupted');
  await writeFile(join(directory, 'operator-notes.txt'), 'keep');
  const store = new RecorderStore(options(directory), () => undefined);
  const other = new RecorderStore(options(directory), () => undefined);
  try {
    await store.start();
    assert.deepEqual(await readdir(directory), ['operator-notes.txt']);
    await assert.rejects(other.start(), /dedicated directory/);
    store.enqueue({ body: 'record' }, new Date());
    await store.stop();
    await other.start();
    await other.stop(); // orderly remount releases ownership
    assert.equal((await records(directory)).length, 1);
  } finally {
    await store.stop();
    await other.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid bounds before creating files and accounts oversized drops', async () => {
  assert.throws(
    () => new RecorderStore(options('/unused', { maxFileMB: 2, maxTotalMB: 1 }), () => undefined),
    /maxFileMB/
  );
  assert.throws(
    () => new RecorderStore(options('/unused', { maxBufferMB: 0 }), () => undefined),
    /positive/
  );
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-recorder-size-'));
  const store = new RecorderStore(options(directory, { maxEntryKB: 1 }), () => undefined);
  try {
    await store.start();
    assert.equal(store.enqueue({ body: 'x'.repeat(2000) }, new Date()), false);
    assert.equal(store.stats.oversized, 1);
    await store.stop();
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
