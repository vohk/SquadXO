import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const execute = promisify(execFile);
const base = resolve('deployment');
const source = await readFile(join(base, 'shared/install.mjs'), 'utf8');
interface Installer {
  unpack: (archive: Buffer) => Map<string, Buffer>;
  mountBoundary: (path: string, info: string) => boolean;
  install: (options: {
    root: string;
    archive?: Buffer;
    checksum?: Buffer;
    name?: string;
    rollback?: string;
    npm?: () => Promise<void>;
  }) => Promise<string>;
}
const installer = (await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
)) as Installer;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function fixture(directory: string, extra: Record<string, string> = {}) {
  const app = join(directory, 'squadxo');
  await mkdir(app, { recursive: true });
  const files = {
    'index.js': "import './dist/src/main.js';\n",
    'dist/src/main.js': 'export {};\n',
    'package.json': JSON.stringify({ engines: { node: '>=24 <25' } }),
    'package-lock.json': '{}',
    'config.example.json': '{}',
    'BUILD_INFO.json': JSON.stringify({ version: 'v1.2.3', revision: 'a'.repeat(40) }),
    ...extra
  };
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(app, file, '..'), { recursive: true });
    await writeFile(join(app, file), contents);
  }
  await writeFile(
    join(app, 'SHA256SUMS'),
    Object.entries(files)
      .map(([file, data]) => `${hash(data)}  ${file}\n`)
      .join('')
  );
  const name = 'squadxo-v1.2.3.tar.gz';
  await execute('tar', [
    '--format=ustar',
    '-czf',
    join(directory, name),
    '-C',
    directory,
    'squadxo'
  ]);
  const archive = await readFile(join(directory, name));
  return { archive, name, checksum: Buffer.from(`${hash(archive)}  ${name}\n`) };
}

test('preservation, isolated stale files, failed-update recovery and rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-deployment-test-'));
  const root = join(directory, 'server');
  await mkdir(root);
  try {
    const paths = [
      'config.json',
      'SquadGame/ServerConfig/Admins.cfg',
      'SquadGame/Saved/Logs/SquadGame.log',
      'ServerConfig/nested/Admins.cfg',
      'Saved/nested/db.sqlite',
      'Logs/nested/SquadGame.log',
      'saved/case-sensitive',
      'custom/other.txt'
    ];
    for (const path of paths) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), `original:${path}`);
    }
    const external = join(directory, 'outside');
    await mkdir(external);
    await writeFile(join(external, 'sentinel'), 'outside');
    await execute('mv', [join(root, 'config.json'), join(external, 'config.json')]);
    await symlink(join(external, 'config.json'), join(root, 'config.json'));
    const old = await installer.install({
      root,
      ...(await fixture(directory, { 'stale.js': 'old' })),
      npm: async () => {}
    });
    // Replace each game-directory fixture with an external link; keep its original subtree outside.
    for (const path of ['SquadGame', 'ServerConfig', 'Saved', 'Logs']) {
      await execute('mv', [join(root, path), join(external, path)]);
      await symlink(join(external, path), join(root, path));
    }
    await symlink(external, join(root, 'database'));
    await execute('rm', [join(directory, 'squadxo/stale.js')]);
    const data = await fixture(directory);
    const fail = async () => {
      throw new Error('npm failed');
    };
    await assert.rejects(installer.install({ root, ...data, npm: fail }), /npm failed/);
    assert.equal(await readlink(join(root, '.squadxo/current')), `releases/${old}`);
    const current = await installer.install({ root, ...data, npm: async () => {} });
    assert.equal(
      (await readdir(join(root, '.squadxo/releases', current))).includes('stale.js'),
      false
    );
    for (const path of paths)
      assert.equal(await readFile(join(root, path), 'utf8'), `original:${path}`);
    assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'outside');
    await installer.install({ root, rollback: old });
    assert.equal(await readlink(join(root, '.squadxo/current')), `releases/${old}`);
    await assert.rejects(
      installer.install({ root, ...data, checksum: Buffer.from('bad') }),
      /checksum/
    );
    const collision = join(directory, 'collision');
    await mkdir(collision);
    await symlink(external, join(collision, '.squadxo'));
    await assert.rejects(installer.install({ root: collision, ...data }), /link|mount/);
    assert.deepEqual(await readdir(collision), ['.squadxo']);
    assert.equal(
      installer.mountBoundary(
        '/srv/app/.squadxo',
        '42 30 8:1 /bound /srv/app/.squadxo rw - ext4 /dev/root rw'
      ),
      true
    );
    assert.throws(() => installer.unpack(Buffer.from('bad')), /header|format|check|incorrect/);
    const protectedArchive = await fixture(directory, { 'Saved/nested/file': 'bad' });
    assert.throws(() => installer.unpack(protectedArchive.archive), /Protected/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public panel formats and exact decoded installer parity', async () => {
  await execute(process.execPath, [join(base, 'shared/generate.mjs'), '--check']);
  const egg = JSON.parse(await readFile(join(base, 'pterodactyl/egg-squadxo.json'), 'utf8'));
  assert.equal(egg.meta.version, 'PTDL_v2');
  assert.equal(egg.scripts.installation.container, 'node:24-trixie-slim');
  assert.equal(Object.values(egg.docker_images)[0], 'ghcr.io/ptero-eggs/yolks:nodejs_24');
  assert.equal(egg.startup, 'node --unhandled-rejections=warn index.js --config config.json');
  assert.equal(egg.config.files, '{}');
  const scripts = [
    egg.scripts.installation.script,
    await readFile(join(base, 'wisp/update.sh'), 'utf8'),
    JSON.parse(await readFile(join(base, 'amp/squadxoupdates.json'), 'utf8'))[0].UpdateSourceArgs
  ];
  for (const script of scripts) {
    const match = /data:text\/javascript;base64,([A-Za-z0-9+/=]+)/.exec(script);
    assert.ok(match?.[1]);
    assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), source);
  }
  const kvp = await readFile(join(base, 'amp/squadxo.kvp'), 'utf8');
  assert.match(kvp, /App.ExecutableLinux={{NodeExecutable}}/);
  assert.match(kvp, /App.PreStartStages=\[\]/);
  for (const [, filename] of kvp.matchAll(/@IncludeJson\[([^\]]+)\]/g)) {
    assert.ok(filename);
    JSON.parse(await readFile(join(base, 'amp', filename), 'utf8'));
  }
  assert.equal(
    JSON.parse(await readFile(join(base, 'amp/manifest.json'), 'utf8')).repotype,
    'AppTemplates'
  );
});
