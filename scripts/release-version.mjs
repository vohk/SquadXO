import { readFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const requested = process.argv[2];
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
if (
  !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
    requested ?? ''
  )
) {
  throw new Error('Expected a version tag such as v1.0.0 or v1.0.0-rc.1');
}
if (requested !== `v${version}`) throw new Error('Release tag must match package.json version');
const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
const revision = stdout.trim();
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${requested}\nrevision=${revision}\nprerelease=${version.includes('-')}\n`
  );
}
process.stdout.write(`${requested} at ${revision}\n`);
