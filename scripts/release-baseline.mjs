import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function releaseBaseline(env = process.env, request = fetch) {
  if (env.GH_REPO !== 'vohk/SquadXO') throw new Error('Expected the public release repository');
  async function get(path) {
    const response = await request(`https://api.github.com/repos/${env.GH_REPO}/${path}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Release baseline: HTTP ${response.status}`);
    return response.json();
  }
  const latest = await get('releases/latest');
  if (!latest) return '';
  if (latest.tag_name !== env.RELEASE_VERSION) return latest.tag_name;
  // A full validation rerun may encounter its own already-published release.
  const releases = await get('releases?per_page=100');
  return (
    releases?.find(
      (release) => !release.draft && !release.prerelease && release.tag_name !== env.RELEASE_VERSION
    )?.tag_name ?? ''
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const previous = await releaseBaseline();
  if (previous && !/^v[0-9A-Za-z.-]+$/.test(previous))
    throw new Error('Invalid previous release tag');
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `previous=${previous}\n`);
}
