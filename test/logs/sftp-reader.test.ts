import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import test from 'node:test';
import { SftpLogReader } from '../../src/logs/sftp-reader.js';

test('copies a bounded SFTP snapshot over an isolated connection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-sftp-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'SquadGame.log');
  const contents = Buffer.from('remote log\n');
  const calls: string[] = [];
  const reader = new SftpLogReader({
    host: 'sftp://example.test',
    port: 2022,
    username: 'test',
    password: 'secret',
    logDir: '/SquadGame/Saved/Logs',
    snapshotClientFactory: () => ({
      async connect(configuration) {
        calls.push(`connect:${configuration.host}:${configuration.port}`);
      },
      async stat(path) {
        calls.push(`stat:${path}`);
        return { size: contents.length, modifyTime: 1_700_000_000_000 };
      },
      async get(path, output: Writable, options) {
        calls.push(`get:${path}:${JSON.stringify(options)}`);
        output.end(contents);
      },
      async end() {
        calls.push('end');
      }
    })
  });

  const result = await reader.copySnapshot(destination, { maximumBytes: 1024 });

  assert.equal(await readFile(destination, 'utf8'), 'remote log\n');
  assert.equal(result.sourceBytes, contents.length);
  assert.equal(result.modifiedAt?.getTime(), 1_700_000_000_000);
  assert.deepEqual(calls, [
    'connect:example.test:2022',
    'stat:/SquadGame/Saved/Logs/SquadGame.log',
    'get:/SquadGame/Saved/Logs/SquadGame.log:{"readStreamOptions":{"start":0,"end":10}}',
    'end'
  ]);
});
