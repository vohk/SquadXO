import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    request: typeof fetch,
    read?: (path: string) => Promise<Buffer>
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
    await execute(process.execPath, [prepare, '1.0.1'], { cwd: root });
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
    assert.equal((await execute('git', ['rev-parse', 'HEAD^'], { cwd: root })).stdout.trim(), base);
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
const baseline = (await import(pathToFileURL(resolve('scripts/release-baseline.mjs')).href)) as {
  releaseBaseline(env: Record<string, string>, request: typeof fetch): Promise<string>;
};
async function publication(options: {
  web?: boolean;
  prerelease?: boolean;
  tag?: 'own' | 'other' | 'wrong-revision';
  existing?: 'draft' | 'published';
  retry?: boolean;
  missingAsset?: boolean;
  badAsset?: boolean;
  movedMain?: boolean;
  movedTag?: boolean;
  badParent?: boolean;
  rejectedPush?: boolean;
}) {
  const commands: string[][] = [];
  const contents = [Buffer.from('validated archive'), Buffer.from('validated checksum')];
  const assets = contents.map((bytes, index) => ({
    name: `squadxo-v1.0.2.tar.gz${index ? '.sha256' : ''}`,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }));
  const env = {
    GH_TOKEN: 'test-token',
    GH_REPO: 'vohk/SquadXO',
    RELEASE_VERSION: 'v1.0.2',
    RELEASE_REVISION: revision,
    BASE_REVISION: base,
    PREVIOUS_TAG: 'v1.0.1',
    RUN_ID: '1234',
    RUN_ATTEMPT: options.retry ? '2' : '1',
    WEB_RELEASE: String(options.web ?? true),
    PRERELEASE: String(options.prerelease ?? false)
  };
  const request = (async (input: string | URL | Request) => {
    const path = String(input).split('/vohk/SquadXO/')[1];
    let data: unknown = null;
    if (path?.startsWith('releases/tags/') && options.existing)
      data = {
        id: 1,
        draft: options.existing === 'draft',
        prerelease: options.prerelease ?? false,
        assets: options.badAsset
          ? [{ ...assets[0], digest: 'sha256:wrong' }, assets[1]]
          : options.missingAsset
            ? [assets[0]]
            : assets
      };
    if (path?.startsWith('git/ref/tags/') && (options.tag || options.web === false))
      data = { object: { type: 'tag', sha: 'c'.repeat(40) } };
    if (path === 'git/ref/heads/main')
      data = { object: { sha: options.movedMain ? 'd'.repeat(40) : base } };
    if (path?.startsWith('git/tags/'))
      data = {
        message: `SquadXO v1.0.2\n\nSource: ${base}\nWorkflow run: ${options.tag === 'own' ? '1234' : '9999'}`,
        object: {
          type: 'commit',
          sha: options.movedTag || options.tag === 'wrong-revision' ? base : revision
        }
      };
    return new Response(JSON.stringify(data), { status: data ? 200 : 404 });
  }) as typeof fetch;
  const run = async (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (args.includes('push') && options.rejectedPush) throw new Error('Tag push rejected');
    return {
      stdout: `${args.includes('HEAD^') ? (options.badParent ? 'd'.repeat(40) : base) : revision}\n`
    };
  };
  const read = async (path: string) => contents[path.endsWith('.sha256') ? 1 : 0]!;
  return { commands, run: () => publisher.publishRelease(env, run, request, read) };
}

test('one-dispatch publication tags the validated child without pushing main or preparation branches', async () => {
  const p = await publication({ web: true });
  await p.run();
  const push = p.commands.find((command) => command.includes('push'))!;
  assert.ok(!push.some((argument) => argument.includes('refs/heads/')));
  assert.ok(!push.some((argument) => argument.startsWith('--force')));
  const release = p.commands.at(-1)!;
  assert.deepEqual(release.slice(0, 3), ['gh', 'release', 'create']);
  assert.ok(release.includes('--verify-tag'));
  assert.ok(release.includes('--generate-notes'));
  assert.equal(release[release.indexOf('--target') + 1], revision);
  assert.equal(release[release.indexOf('--notes-start-tag') + 1], 'v1.0.1');
  assert.ok(release.includes('--latest'));
});

test('publication refuses other runs, conflicting revisions, changed main and unrelated ancestry', async () => {
  for (const options of [
    { existing: 'published' as const },
    { tag: 'other' as const, retry: true },
    { tag: 'wrong-revision' as const, retry: true },
    { tag: 'own' as const },
    { movedMain: true },
    { badParent: true },
    { rejectedPush: true }
  ]) {
    const p = await publication(options);
    await assert.rejects(p.run());
    assert.ok(!p.commands.some((command) => command[0] === 'gh'));
  }
});

test('same-run failed-job retry reuses its exact tag after main advances', async () => {
  const p = await publication({ tag: 'own', retry: true, movedMain: true });
  await p.run();
  assert.ok(!p.commands.some((command) => command.includes('push') || command.includes('tag')));
  assert.deepEqual(p.commands.at(-1)!.slice(0, 3), ['gh', 'release', 'create']);
});

test('same-run retry completes a partial draft without replacing matching assets or notes', async () => {
  const p = await publication({ tag: 'own', retry: true, existing: 'draft', missingAsset: true });
  await p.run();
  const writes = p.commands.filter((command) => command[0] === 'gh');
  assert.deepEqual(writes[0], [
    'gh',
    'release',
    'upload',
    'v1.0.2',
    'release-assets/squadxo-v1.0.2.tar.gz.sha256'
  ]);
  assert.ok(!writes.flat().includes('--clobber'));
  assert.deepEqual(writes[1], ['gh', 'release', 'edit', 'v1.0.2', '--draft=false', '--latest']);
});

test('published retry verifies exact assets without mutation and refuses conflicting or missing bytes', async () => {
  const completed = await publication({ tag: 'own', retry: true, existing: 'published' });
  await completed.run();
  assert.ok(!completed.commands.some((command) => command[0] === 'gh' || command.includes('push')));
  for (const options of [
    { existing: 'draft' as const, badAsset: true },
    { existing: 'published' as const, badAsset: true },
    { existing: 'published' as const, missingAsset: true }
  ]) {
    const p = await publication({ tag: 'own', retry: true, ...options });
    await assert.rejects(p.run());
    assert.ok(!p.commands.some((command) => command[0] === 'gh'));
  }
});

test('tag-triggered publication verifies the remote revision and keeps prereleases out of latest', async () => {
  const p = await publication({ web: false, prerelease: true });
  await p.run();
  assert.ok(!p.commands.some((command) => command.includes('push')));
  assert.ok(p.commands.at(-1)!.includes('--latest=false'));
  assert.ok(p.commands.at(-1)!.includes('--prerelease'));
  const moved = await publication({ web: false, movedTag: true });
  await assert.rejects(moved.run(), /Remote tag moved/);
  assert.ok(!moved.commands.some((command) => command[0] === 'gh'));
});

test('notes baseline pins latest stable and skips the current release, drafts and prereleases', async () => {
  const env = { GH_REPO: 'vohk/SquadXO', GH_TOKEN: 'test-token', RELEASE_VERSION: 'v1.0.2' };
  const simple = (async () => new Response(JSON.stringify({ tag_name: 'v1.0.1' }))) as typeof fetch;
  assert.equal(await baseline.releaseBaseline(env, simple), 'v1.0.1');
  const repeat = (async (input: string | URL | Request) =>
    new Response(
      JSON.stringify(
        String(input).endsWith('latest')
          ? { tag_name: 'v1.0.2' }
          : [
              { tag_name: 'v1.0.3', draft: true },
              { tag_name: 'v1.0.3-rc.1', prerelease: true },
              { tag_name: 'v1.0.2' },
              { tag_name: 'v1.0.1' }
            ]
      )
    )) as typeof fetch;
  assert.equal(await baseline.releaseBaseline(env, repeat), 'v1.0.1');
});

test('first release has no notes baseline and API failures stop instead of silently guessing', async () => {
  const env = { GH_REPO: 'vohk/SquadXO', GH_TOKEN: 'test-token', RELEASE_VERSION: 'v1.0.0' };
  assert.equal(
    await baseline.releaseBaseline(
      env,
      (async () => new Response(null, { status: 404 })) as typeof fetch
    ),
    ''
  );
  await assert.rejects(
    baseline.releaseBaseline(
      env,
      (async () => new Response(null, { status: 403 })) as typeof fetch
    ),
    /HTTP 403/
  );
});

test('real Git tag push and same-run retry preserve main and the exact release-only commit', async () => {
  await fixture(async (root) => {
    const remote = await mkdtemp(join(tmpdir(), 'squadxo-release-remote-'));
    try {
      const base = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      await execute('git', ['init', '--bare', '-q', remote]);
      await execute('git', ['remote', 'add', 'origin', remote], { cwd: root });
      await execute('git', ['push', '-q', 'origin', `${base}:refs/heads/main`], { cwd: root });
      await execute(process.execPath, [prepare, '1.0.2'], { cwd: root });
      const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      const env = {
        GH_TOKEN: 'test-token',
        GH_REPO: 'vohk/SquadXO',
        RELEASE_VERSION: 'v1.0.2',
        RELEASE_REVISION: revision,
        BASE_REVISION: base,
        WEB_RELEASE: 'true',
        PRERELEASE: 'false',
        PREVIOUS_TAG: 'v1.0.1',
        RUN_ID: '1234',
        RUN_ATTEMPT: '1'
      };
      const writes: string[][] = [];
      const run = async (command: string, args: string[]) => {
        if (command === 'gh') {
          writes.push(args);
          return { stdout: '' };
        }
        return execute(command, args, { cwd: root });
      };
      const request = (async (input: string | URL | Request) => {
        const path = String(input).split('/vohk/SquadXO/')[1];
        let data: unknown = null;
        if (path === 'git/ref/heads/main') data = { object: { sha: base } };
        if (path === 'git/ref/tags/v1.0.2') {
          try {
            const sha = (
              await execute('git', ['rev-parse', 'refs/tags/v1.0.2'], { cwd: remote })
            ).stdout.trim();
            data = { object: { type: 'tag', sha } };
          } catch {
            /* The first attempt has not created its tag yet. */
          }
        }
        if (path?.startsWith('git/tags/')) {
          const text = (
            await execute('git', ['cat-file', '-p', path.split('/').at(-1)!], { cwd: remote })
          ).stdout;
          data = {
            object: { type: 'commit', sha: /^object ([a-f0-9]+)/m.exec(text)![1] },
            message: text.slice(text.indexOf('\n\n') + 2)
          };
        }
        return new Response(JSON.stringify(data), { status: data ? 200 : 404 });
      }) as typeof fetch;
      await publisher.publishRelease(env, run, request);
      env.RUN_ATTEMPT = '2';
      await publisher.publishRelease(env, run, request);
      assert.equal(writes.length, 2);
      assert.equal(
        (await execute('git', ['rev-parse', 'refs/heads/main'], { cwd: remote })).stdout.trim(),
        base
      );
      assert.equal(
        (await execute('git', ['rev-parse', 'v1.0.2^{commit}'], { cwd: remote })).stdout.trim(),
        revision
      );
      assert.equal(
        (
          await execute('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/'], {
            cwd: remote
          })
        ).stdout.trim(),
        'refs/heads/main'
      );
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});
