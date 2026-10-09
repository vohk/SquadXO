import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const version = process.argv[2];
if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(
    version ?? ''
  )
) {
  throw new Error('Enter a version such as 1.0.2 or 1.0.2-rc.1, without a v prefix');
}
const files = [
  'package.json',
  'assets/package.json',
  'core/package.json',
  'squad-server/package.json',
  'package-lock.json'
];
const { stdout: status } = await execute('git', ['status', '--porcelain']);
if (status.trim()) throw new Error('Release preparation requires a clean checkout');
const manifests = await Promise.all(
  files.map(async (file) => JSON.parse(await readFile(file, 'utf8')))
);
for (const manifest of manifests) manifest.version = version;
manifests[0].dependencies['squad-server'] = version;
manifests[3].dependencies.core = version;
const lock = manifests[4];
for (const key of ['', 'assets', 'core', 'squad-server']) lock.packages[key].version = version;
lock.packages[''].dependencies['squad-server'] = version;
lock.packages['squad-server'].dependencies.core = version;
await Promise.all(
  files.map((file, index) => writeFile(file, `${JSON.stringify(manifests[index], null, 2)}\n`))
);
const { stdout: changed } = await execute('git', ['diff', '--name-only']);
if (changed.trim()) {
  await execute('git', ['add', '--', ...files]);
  await execute('git', [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    '-m',
    `Release v${version}`
  ]);
}
