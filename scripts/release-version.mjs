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
const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const server = JSON.parse(await readFile(new URL('../squad-server/package.json', import.meta.url)));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
for (const file of ['assets/package.json', 'core/package.json', 'squad-server/package.json']) {
  if (JSON.parse(await readFile(new URL(`../${file}`, import.meta.url))).version !== version) {
    throw new Error(`Workspace version mismatch: ${file}`);
  }
}
if (
  root.dependencies['squad-server'] !== version ||
  server.dependencies.core !== version ||
  lock.version !== version ||
  lock.packages[''].dependencies['squad-server'] !== version ||
  lock.packages['squad-server'].dependencies.core !== version ||
  ['', 'assets', 'core', 'squad-server'].some((key) => lock.packages[key].version !== version)
) {
  throw new Error('Release manifests and lockfile must have synchronized versions');
}

const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
const revision = stdout.trim();
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${requested}\nrevision=${revision}\nprerelease=${version.includes('-')}\n`
  );
}
process.stdout.write(`${requested} at ${revision}\n`);
