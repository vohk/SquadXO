import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function publishRelease(
  env = process.env,
  execute = promisify(execFile),
  request = fetch,
  read = readFile
) {
  const {
    GH_TOKEN,
    GH_REPO,
    RELEASE_VERSION,
    RELEASE_REVISION,
    BASE_REVISION,
    WEB_RELEASE,
    PRERELEASE,
    PREVIOUS_TAG,
    RUN_ID,
    RUN_ATTEMPT
  } = env;
  if (GH_REPO !== 'vohk/SquadXO' || !GH_TOKEN)
    throw new Error('Publication requires the public repository token');
  if (
    !/^v[0-9A-Za-z.-]+$/.test(RELEASE_VERSION ?? '') ||
    !/^[a-f0-9]{40}$/.test(RELEASE_REVISION ?? '') ||
    (PREVIOUS_TAG && !/^v[0-9A-Za-z.-]+$/.test(PREVIOUS_TAG))
  )
    throw new Error('Invalid validated release identity');
  const web = WEB_RELEASE === 'true';
  if (web && (!/^[a-f0-9]{40}$/.test(BASE_REVISION ?? '') || !/^\d+$/.test(RUN_ID ?? '')))
    throw new Error('Missing pinned source or workflow run identity');
  async function api(path, allowMissing = false) {
    const response = await request(`https://api.github.com/repos/${GH_REPO}/${path}`, {
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(20000)
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const tag = await api(`git/ref/tags/${RELEASE_VERSION}`, true);
  let tagRevision = tag?.object;
  let message = '';
  while (tagRevision?.type === 'tag') {
    const annotation = await api(`git/tags/${tagRevision.sha}`);
    message += `${annotation.message}\n`;
    tagRevision = annotation.object;
  }
  const retry = Number(RUN_ATTEMPT) > 1;
  const ownTag =
    web &&
    tagRevision?.sha === RELEASE_REVISION &&
    message.includes(`\nWorkflow run: ${RUN_ID}\n`) &&
    message.includes(`\nSource: ${BASE_REVISION}\n`);
  if (web && tag && !(retry && ownTag))
    throw new Error('Tag already exists; refusing a different run or revision');
  if (!web && tagRevision?.sha !== RELEASE_REVISION)
    throw new Error('Remote tag moved or is missing');
  const existing = await api(`releases/tags/${RELEASE_VERSION}`, true);
  if (existing && !(web && retry && ownTag))
    throw new Error('Release already exists; refusing to replace it');
  const { stdout: head } = await execute('git', ['rev-parse', 'HEAD']);
  if (head.trim() !== RELEASE_REVISION)
    throw new Error('Checkout does not match the validated revision');
  if (web && !tag) {
    const main = await api('git/ref/heads/main');
    if (main.object.sha !== BASE_REVISION)
      throw new Error('Main changed during validation; start a new run');
    if (RELEASE_REVISION !== BASE_REVISION) {
      const { stdout: parent } = await execute('git', ['rev-parse', 'HEAD^']);
      if (parent.trim() !== BASE_REVISION)
        throw new Error('Release commit must directly descend from pinned main');
    }
    await execute('git', [
      '-c',
      'tag.gpgsign=false',
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag',
      '-a',
      RELEASE_VERSION,
      '-m',
      `SquadXO ${RELEASE_VERSION}\n\nSource: ${BASE_REVISION}\nWorkflow run: ${RUN_ID}`,
      RELEASE_REVISION
    ]);
    // Push only this tag. Protected main and preparation branches are never updated.
    await execute('git', [
      '-c',
      'push.followTags=false',
      'push',
      '--no-follow-tags',
      'origin',
      `refs/tags/${RELEASE_VERSION}:refs/tags/${RELEASE_VERSION}`
    ]);
  }
  const assets = [
    `release-assets/squadxo-${RELEASE_VERSION}.tar.gz`,
    `release-assets/squadxo-${RELEASE_VERSION}.tar.gz.sha256`
  ];
  const flags = PRERELEASE === 'true' ? ['--prerelease', '--latest=false'] : ['--latest'];
  if (existing) {
    // CLI creation may leave a partial draft after a network/upload failure.
    // Resume only this run's tag and never replace a different uploaded asset.
    const missing = [];
    for (const file of assets) {
      const asset = existing.assets.find((item) => item.name === basename(file));
      if (!asset) {
        missing.push(file);
        continue;
      }
      const digest = `sha256:${createHash('sha256')
        .update(await read(file))
        .digest('hex')}`;
      if (asset.digest !== digest)
        throw new Error('Existing release asset differs from validated bytes');
    }
    if (Boolean(existing.prerelease) !== (PRERELEASE === 'true'))
      throw new Error('Existing release channel differs');
    if (!existing.draft) {
      if (missing.length) throw new Error('Published release is missing validated assets');
      return; // Previous attempt completed: verified idempotent success.
    }
    if (missing.length) await execute('gh', ['release', 'upload', RELEASE_VERSION, ...missing]);
    await execute('gh', ['release', 'edit', RELEASE_VERSION, '--draft=false', ...flags]);
    return;
  }
  const notes = PREVIOUS_TAG ? ['--notes-start-tag', PREVIOUS_TAG] : [];
  await execute('gh', [
    'release',
    'create',
    RELEASE_VERSION,
    ...assets,
    '--verify-tag',
    '--target',
    RELEASE_REVISION,
    '--title',
    `SquadXO ${RELEASE_VERSION}`,
    '--generate-notes',
    ...notes,
    ...flags
  ]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await publishRelease();
