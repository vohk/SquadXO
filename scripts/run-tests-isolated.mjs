import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cacheRoot = await mkdtemp(join(tmpdir(), 'squadxo-test-cache-'));
const environment = { ...process.env, XDG_CACHE_HOME: cacheRoot };
let activeChild;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => activeChild?.kill(signal));
}

try {
  const args = process.argv.slice(2);
  const requestedFiles = args;
  let exitCode = await run(npmCommand, ['run', 'build'], environment);
  if (exitCode === 0) {
    const testFiles =
      requestedFiles.length > 0
        ? requestedFiles.map((file) => resolve(repository, file))
        : await findTestFiles(resolve(repository, 'dist', 'test'));
    if (testFiles.length === 0) throw new Error('No compiled test files were found.');
    exitCode = await run(process.execPath, ['--test', ...testFiles], environment);
  }
  process.exitCode = exitCode;
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}

async function findTestFiles(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findTestFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

function run(command, arguments_, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: repository,
      env,
      stdio: 'inherit'
    });
    activeChild = child;
    child.once('error', (error) => {
      if (activeChild === child) activeChild = undefined;
      rejectRun(error);
    });
    child.once('exit', (code) => {
      if (activeChild === child) activeChild = undefined;
      resolveRun(code ?? 1);
    });
  });
}
