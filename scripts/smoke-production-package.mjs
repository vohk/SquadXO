import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [input, version, revision] = process.argv.slice(2);
if (!input || !version || !/^[a-f0-9]{40}$/.test(revision ?? '')) {
  throw new Error('Usage: smoke-production-package.mjs ARCHIVE VERSION COMMIT');
}
const archive = resolve(input);
const checksum = (await readFile(`${archive}.sha256`, 'utf8')).trim().split(/\s+/)[0];
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
assert.equal(hash.digest('hex'), checksum, 'Archive checksum mismatch');
const listing = await execute('tar', ['-tzf', archive]);
for (const entry of listing.stdout.trim().split('\n')) {
  assert.ok(entry === 'squadxo/' || entry.startsWith('squadxo/'), 'Unexpected archive root');
  assert.ok(!entry.split('/').includes('..') && !entry.startsWith('/'), 'Unsafe archive path');
}
const temporary = await mkdtemp(join(tmpdir(), 'squadxo-release-smoke-'));
try {
  await execute('tar', ['-xzf', archive, '-C', temporary]);
  const root = join(temporary, 'squadxo');
  for (const entry of await readdir(root)) {
    assert.ok(
      ![
        '.git',
        '.github',
        '.env',
        'config.json',
        'node_modules',
        'src',
        'test',
        'scripts',
        'data',
        'logs'
      ].includes(entry),
      'Unexpected package content'
    );
  }
  await assertRegularTree(root);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'BUILD_INFO.json'), 'utf8')), {
    version,
    revision
  });
  await execute('sha256sum', ['--check', 'SHA256SUMS'], { cwd: root });
  // The archive installs exactly as an operator installs it. No server is started.
  await execute('npm', ['ci', '--omit=dev'], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024
  });
  const fixture = join(temporary, 'config.json');
  await writeFile(
    fixture,
    JSON.stringify({
      server: {
        id: 1,
        host: '127.0.0.1',
        rconPort: 1,
        rconPassword: 'fixture-only',
        logReaderMode: 'tail',
        logDir: temporary
      },
      plugins: [],
      connectors: {},
      configManagement: { reorderOnStartup: false }
    })
  );
  const loader = pathToFileURL(join(root, 'dist/src/config/runtime-config.js')).href;
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {loadRuntimeConfig}=await import(${JSON.stringify(loader)});const c=await loadRuntimeConfig(${JSON.stringify(fixture)});if(c.server.id!==1)throw Error('Config smoke failed');`
    ],
    { cwd: root }
  );
  // Planning/import checks use public shipped code and fixtures, never a live runtime.
  for (const file of [
    'dist/src/plugins/loader.js',
    'dist/src/compatibility/legacy-plugin-plan.js',
    'dist/src/server/integrated-runtime.js'
  ]) {
    await execute(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(join(root, file)).href)})`
      ],
      { cwd: root }
    );
  }
  process.stdout.write(
    'Archive checksums, production installation and offline runtime imports passed.\n'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function assertRegularTree(directory) {
  for (const name of await readdir(directory)) {
    const file = join(directory, name);
    const metadata = await lstat(file);
    if (metadata.isDirectory()) await assertRegularTree(file);
    else assert.ok(metadata.isFile(), 'Package contains a non-regular file');
  }
}
