import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function publishRelease(
  env = process.env,
  execute = promisify(execFile),
  request = fetch
) {
  const {
    GH_TOKEN,
    GH_REPO,
    RELEASE_VERSION,
    RELEASE_REVISION,
    BASE_REVISION,
    WEB_RELEASE,
    PRERELEASE
  } = env;
  if (GH_REPO !== 'vohk/SquadXO' || !GH_TOKEN)
    throw new Error('Publication requires the public repository token');
  if (
    !/^v[0-9A-Za-z.-]+$/.test(RELEASE_VERSION ?? '') ||
    !/^[a-f0-9]{40}$/.test(RELEASE_REVISION ?? '')
  )
    throw new Error('Invalid validated release identity');
  async function api(path, allowMissing = false) {
    const response = await request(`https://api.github.com/repos/${GH_REPO}/${path}`, {
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  }
  if (await api(`releases/tags/${RELEASE_VERSION}`, true))
    throw new Error('Release already exists; refusing to replace it');
  const tag = await api(`git/ref/tags/${RELEASE_VERSION}`, true);
  if (WEB_RELEASE === 'true') {
    if (tag) throw new Error('Tag already exists; refusing to move it');
    const main = await api('git/ref/heads/main');
    if (main.object.sha !== BASE_REVISION)
      throw new Error('Main changed during validation; start a new run');
    const { stdout } = await execute('git', ['rev-parse', 'HEAD']);
    if (stdout.trim() !== RELEASE_REVISION)
      throw new Error('Checkout does not match the validated revision');
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
      `SquadXO ${RELEASE_VERSION}`,
      RELEASE_REVISION
    ]);
    // One atomic push: a rejected branch update must not leave a release tag behind.
    await execute('git', [
      '-c',
      'push.followTags=false',
      'push',
      '--atomic',
      '--no-follow-tags',
      'origin',
      'HEAD:refs/heads/main',
      `refs/tags/${RELEASE_VERSION}:refs/tags/${RELEASE_VERSION}`
    ]);
  } else {
    if (!tag) throw new Error('Validated tag is missing');
    const { stdout } = await execute('git', ['rev-parse', `${RELEASE_VERSION}^{commit}`]);
    if (stdout.trim() !== RELEASE_REVISION)
      throw new Error('Tag does not match the validated revision');
    // Recheck the remote tag, including annotated tags, to catch movement after checkout.
    let object = tag.object;
    while (object.type === 'tag') object = (await api(`git/tags/${object.sha}`)).object;
    if (object.sha !== RELEASE_REVISION) throw new Error('Remote tag moved during validation');
  }
  const flags = PRERELEASE === 'true' ? ['--prerelease', '--latest=false'] : ['--latest'];
  await execute('gh', [
    'release',
    'create',
    RELEASE_VERSION,
    `release-assets/squadxo-${RELEASE_VERSION}.tar.gz`,
    `release-assets/squadxo-${RELEASE_VERSION}.tar.gz.sha256`,
    '--verify-tag',
    '--title',
    `SquadXO ${RELEASE_VERSION}`,
    '--generate-notes',
    ...flags
  ]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await publishRelease();
