import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
const approved = JSON.parse(
  await readFile(join(repository, 'scripts/package-inputs.json'), 'utf8')
);
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--version')) {
  throw new Error('Usage: package:production -- [--version VERSION]');
}
const version = args[1] ?? manifest.version;
if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) throw new Error('Invalid archive version');
let revision = null;
try {
  await lstat(join(repository, '.git'));
  const { stdout: status } = await execute(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: repository }
  );
  if (status.trim()) throw new Error('Refusing to package a dirty worktree');
  const result = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: repository
  });
  revision = result.stdout.trim();
} catch (error) {
  if (!error || error.code !== 'ENOENT') throw error;
}
const actualSources = (await walk(join(repository, 'src')))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => `src/${file}`);
assertInputs(actualSources, approved.runtimeSources);
await execute(process.execPath, [join(repository, 'scripts/build.mjs')], {
  cwd: repository
});
const { buildConfig, buildReadme, buildReference } =
  await import('../squad-server/scripts/plugin-metadata.js');
for (const [file, generated] of [
  ['config.example.json', `${JSON.stringify(await buildConfig(), null, 2)}\n`],
  ['README.md', await buildReadme()],
  ['docs/reference/plugins.md', await buildReference()]
]) {
  if ((await readFile(join(repository, file), 'utf8')) !== generated)
    throw new Error(`Regenerate ${file} before packaging`);
}
const artifacts = join(repository, 'artifacts');
const staging = join(artifacts, 'squadxo');
const archive = join(artifacts, `squadxo-${version}.tar.gz`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  const files = [
    '.npmrc',
    'README.md',
    'LICENSE',
    'squadxo-header.png',
    'config.example.json',
    'index.js',
    'package.json',
    'package-lock.json',
    'assets/package.json',
    'core/package.json',
    'core/logger.js',
    'squad-server/package.json',
    'squad-server/utils/constants.js',
    'squad-server/utils/team-switch.js',
    'docs/reference/plugins.md',
    'docs/deployment/migration.md',
    'docs/deployment/production.md',
    'docs/contracts/database-connectors.md',
    'docs/contracts/db-log-schema.md',
    'docs/contracts/native-plugin-authoring.md',
    'docs/contracts/legacy-plugin-compatibility.md'
  ];
  const legacyFiles = [];
  for (const directory of ['squad-server/plugins', 'squad-server/layers']) {
    for (const file of await walk(join(repository, directory))) {
      if (file.endsWith('.js')) legacyFiles.push(`${directory}/${file}`);
    }
  }
  assertInputs(legacyFiles, approved.legacyFiles);
  files.push(...legacyFiles);
  const compiled = (await walk(join(repository, 'dist/src')))
    .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'))
    .map((file) => `dist/src/${file}`);
  const expectedCompiled = approved.runtimeSources
    .filter((file) => !file.endsWith('.d.ts'))
    .flatMap((file) => [
      file.replace(/^src\//, 'dist/src/').replace(/\.ts$/, '.js'),
      file.replace(/^src\//, 'dist/src/').replace(/\.ts$/, '.d.ts')
    ]);
  assertInputs(compiled, expectedCompiled);
  files.push(...compiled);
  for (const file of files) {
    const source = join(repository, file);
    if (!(await lstat(source)).isFile())
      throw new Error(`Package input is not a regular file: ${file}`);
    const destination = join(staging, file);
    await mkdir(dirname(destination), { recursive: true });
    if (file === 'package.json') {
      const runtimeManifest = {
        ...manifest,
        scripts: Object.fromEntries(
          ['start:production', 'db:eos-backfill', 'format-config'].map((name) => [
            name,
            manifest.scripts[name]
          ])
        )
      };
      await writeFile(destination, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
    } else if (file === 'README.md') {
      const contents = await readFile(source, 'utf8');
      await writeFile(
        destination,
        contents
          .replace(/## Source checkout[\s\S]*?(?=## Credits and license)/, '')
          .replace(
            'Build a versioned archive from a clean source checkout as described in [Deployment](docs/deployment/production.md), verify its checksum and extract it into an empty directory.',
            'Verify the archive checksum and extract it into an empty directory.'
          )
      );
    } else if (file === 'docs/reference/plugins.md') {
      const contents = await readFile(source, 'utf8');
      await writeFile(
        destination,
        contents.replace(' Run `npm run build-all` after changing plugin metadata.', '')
      );
    } else if (file === 'docs/deployment/production.md') {
      const contents = await readFile(source, 'utf8');
      await writeFile(
        destination,
        contents.slice(0, contents.indexOf('From a clean source checkout:')) +
          contents.slice(contents.indexOf('## Install and start'))
      );
    } else await cp(source, destination, { errorOnExist: true });
  }
  await writeFile(
    join(staging, 'BUILD_INFO.json'),
    `${JSON.stringify({ version, revision }, null, 2)}\n`
  );
  const checksums = [];
  for (const file of await walk(staging))
    checksums.push(`${await digest(join(staging, file))}  ${file}`);
  await writeFile(join(staging, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  await execute('tar', [
    '--sort=name',
    '--mtime=1970-01-01 UTC',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    archive,
    '-C',
    artifacts,
    'squadxo'
  ]);
  await writeFile(
    `${archive}.sha256`,
    `${await digest(archive)}  ${relative(artifacts, archive)}\n`
  );
  console.log(`Created ${relative(repository, archive)}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      files.push(
        ...(await walk(join(directory, entry.name))).map((file) => `${entry.name}/${file}`)
      );
    else if (entry.isFile()) files.push(entry.name);
    else throw new Error(`Unsupported file type in ${directory}`);
  }
  return files.sort();
}

function assertInputs(actual, expected) {
  if (
    !Array.isArray(expected) ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  )
    throw new Error(
      'Package inputs changed; review and update scripts/package-inputs.json before packaging'
    );
}
