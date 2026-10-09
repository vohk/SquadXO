import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAdminLists, parseAdminListSources } from '../../src/compatibility/admin-lists.js';

test('loads and merges local and remote EOS-first admin lists', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-admin-lists-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'Admins.cfg'),
    ['Group=admin:canseeadminchat, balance', 'Admin=11111111111111111111111111111111:admin'].join(
      '\n'
    )
  );
  const remote = [
    'Group=reserved:reserve // retained comment',
    'Admin=11111111111111111111111111111111:reserved',
    'Admin=76561198000000001:reserved'
  ].join('\n');

  const result = await loadAdminLists(
    [
      { type: 'local', source: 'Admins.cfg' },
      { type: 'remote', source: 'https://example.test/Admins.cfg' }
    ],
    {
      baseDirectory: directory,
      fetch: async () => new Response(remote)
    }
  );

  assert.equal(result.loadedSources, 2);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.admins['11111111111111111111111111111111'], {
    canseeadminchat: true,
    balance: true,
    reserve: true
  });
  assert.deepEqual(result.admins['76561198000000001'], { reserve: true });
});

test('isolates failed sources and validates configured transports', async () => {
  const result = await loadAdminLists(
    [
      { type: 'remote', source: 'https://example.test/failed' },
      { type: 'remote', source: 'https://example.test/healthy' }
    ],
    {
      fetch: async (input) =>
        String(input).endsWith('/failed')
          ? new Response('no', { status: 503 })
          : new Response('Group=admin:canseeadminchat\nAdmin=76561198000000001:admin')
    }
  );
  assert.equal(result.loadedSources, 1);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.admins['76561198000000001'], { canseeadminchat: true });
  assert.deepEqual(parseAdminListSources([{ type: '', source: '' }]), []);
  assert.throws(
    () => parseAdminListSources([{ type: 'ftp', source: 'ftp://example.test/Admins.cfg' }]),
    /local or remote/
  );
});
