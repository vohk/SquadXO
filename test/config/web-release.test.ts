import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const prepare = resolve('scripts/prepare-web-release.mjs');
const versionCheck = await readFile('scripts/release-version.mjs', 'utf8');
const publisher = (await import(pathToFileURL(resolve('scripts/publish-release.mjs')).href)) as {
  publishRelease(
    env: Record<string, string>,
    execute: (command: string, args: string[]) => Promise<{ stdout: string }>,
    request: typeof fetch
  ): Promise<void>;
};

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'squadxo-web-release-'));
  try {
    for (const dir of ['assets', 'core', 'squad-server', 'scripts']) {
      await mkdir(join(root, dir));
    }
    for (const file of [
      'package.json',
      'assets/package.json',
      'core/package.json',
      'squad-server/package.json',
      'package-lock.json'
    ]) {
      await writeFile(join(root, file), await readFile(file));
    }
    await writeFile(join(root, 'scripts/release-version.mjs'), versionCheck);
    await execute('git', ['init', '-q'], { cwd: root });
    await execute('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    await execute('git', ['config', 'user.name', 'Release test'], { cwd: root });
    await execute('git', ['config', 'user.email', 'release@example.invalid'], { cwd: root });
    await execute('git', ['add', '.'], { cwd: root });
    await execute('git', ['commit', '-qm', 'Fixture'], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('web version preparation synchronizes workspace links and lockfile without changing dependencies', async () => {
  await fixture(async (root) => {
    const previous = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    const base = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await execute(process.execPath, [prepare, '1.0.2-rc.1'], { cwd: root });
    await execute(process.execPath, ['scripts/release-version.mjs', 'v1.0.2-rc.1'], { cwd: root });
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    for (const key of ['', 'assets', 'core', 'squad-server'])
      assert.equal(lock.packages[key].version, '1.0.2-rc.1');
    assert.equal(lock.packages[''].dependencies['squad-server'], '1.0.2-rc.1');
    assert.equal(lock.packages['squad-server'].dependencies.core, '1.0.2-rc.1');
    assert.equal(
      lock.packages[''].dependencies['discord.js'],
      previous.packages[''].dependencies['discord.js']
    );
    assert.deepEqual(lock.packages['node_modules/core'], previous.packages['node_modules/core']);
    assert.equal((await execute('git', ['status', '--porcelain'], { cwd: root })).stdout, '');
    const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    assert.notEqual(revision, base);
    await execute(process.execPath, [prepare, '1.0.2-rc.1'], { cwd: root });
    assert.equal(
      (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
      revision
    );
    // The transferred bundle must preserve the precise commit used by BUILD_INFO.
    const bundle = join(root, 'source.bundle');
    await execute('git', ['bundle', 'create', bundle, 'HEAD', '--not', base], { cwd: root });
    await execute('git', ['reset', '--hard', base], { cwd: root });
    await execute('git', ['fetch', bundle, 'HEAD'], { cwd: root });
    assert.equal(
      (await execute('git', ['rev-parse', 'FETCH_HEAD'], { cwd: root })).stdout.trim(),
      revision
    );
  });
});

test('web preparation rejects malformed versions and dirty checkouts before changing files', async () => {
  await fixture(async (root) => {
    const before = await readFile(join(root, 'package.json'), 'utf8');
    for (const version of ['', 'v1.0.2', '1.02.3', '1.0.2-01', '1.0.2\nrevision=bad']) {
      await assert.rejects(execute(process.execPath, [prepare, version], { cwd: root }));
    }
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before);
    await writeFile(join(root, 'unrelated.txt'), 'Keep this change');
    await assert.rejects(
      execute(process.execPath, [prepare, '1.0.2'], { cwd: root }),
      /clean checkout/
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before);
  });
});

test('tag validation rejects an out-of-sync workspace lock version', async () => {
  await fixture(async (root) => {
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    lock.packages.core.version = '0.0.0';
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
    await assert.rejects(
      execute(process.execPath, ['scripts/release-version.mjs', 'v1.0.1'], { cwd: root }),
      /synchronized/
    );
  });
});

const revision = 'a'.repeat(40);
const base = 'b'.repeat(40);
async function publication(options: {
  web?: boolean;
  prerelease?: boolean;
  duplicateRelease?: boolean;
  duplicateTag?: boolean;
  movedMain?: boolean;
  movedTag?: boolean;
  rejectedPush?: boolean;
}) {
  const commands: string[][] = [];
  const env = {
    GH_TOKEN: 'test-token',
    GH_REPO: 'vohk/SquadXO',
    RELEASE_VERSION: 'v1.0.2',
    RELEASE_REVISION: revision,
    BASE_REVISION: base,
    WEB_RELEASE: String(options.web ?? true),
    PRERELEASE: String(options.prerelease ?? false)
  };
  const request = (async (input: string | URL | Request) => {
    const path = String(input).split('/vohk/SquadXO/')[1];
    let data: unknown = null;
    if (path?.startsWith('releases/tags/') && options.duplicateRelease) data = { id: 1 };
    if (
      path?.startsWith('git/ref/tags/') &&
      (options.duplicateTag || (!options.web && options.web !== undefined))
    )
      data = { object: { type: 'tag', sha: 'c'.repeat(40) } };
    if (path === 'git/ref/heads/main')
      data = { object: { sha: options.movedMain ? 'd'.repeat(40) : base } };
    if (path?.startsWith('git/tags/'))
      data = { object: { type: 'commit', sha: options.movedTag ? base : revision } };
    return new Response(JSON.stringify(data), { status: data ? 200 : 404 });
  }) as typeof fetch;
  const run = async (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (args.includes('push') && options.rejectedPush)
      throw new Error('Branch protection rejected push');
    return { stdout: `${revision}\n` };
  };
  return { commands, run: () => publisher.publishRelease(env, run, request) };
}

test('web publication pushes branch and exact tag atomically before publishing stable latest', async () => {
  const p = await publication({ web: true });
  await p.run();
  const push = p.commands.find((command) => command.includes('push'))!;
  assert.ok(push.includes('--atomic'));
  assert.ok(push.includes(`--force-with-lease=refs/heads/main:${base}`));
  assert.ok(push.includes('HEAD:refs/heads/main'));
  assert.ok(push.includes('refs/tags/v1.0.2:refs/tags/v1.0.2'));
  const release = p.commands.at(-1)!;
  assert.deepEqual(release.slice(0, 3), ['gh', 'release', 'create']);
  assert.ok(release.includes('--verify-tag'));
  assert.ok(release.includes('--generate-notes'));
  assert.ok(release.includes('--latest'));
});

test('publication refuses duplicate identities, moved main and rejected branch writes', async () => {
  for (const options of [
    { duplicateRelease: true },
    { duplicateTag: true },
    { movedMain: true },
    { rejectedPush: true }
  ]) {
    const p = await publication(options);
    await assert.rejects(p.run());
    assert.ok(!p.commands.some((command) => command[0] === 'gh'));
  }
});

test('tag publication checks the remote peeled revision and keeps prereleases out of latest', async () => {
  const p = await publication({ web: false, prerelease: true });
  await p.run();
  assert.ok(!p.commands.some((command) => command.includes('push')));
  assert.ok(p.commands.at(-1)!.includes('--latest=false'));
  assert.ok(p.commands.at(-1)!.includes('--prerelease'));
  const moved = await publication({ web: false, movedTag: true });
  await assert.rejects(moved.run(), /Remote tag moved/);
  assert.ok(!moved.commands.some((command) => command[0] === 'gh'));
});
