import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await rm(resolve(repository, 'dist'), { recursive: true, force: true });
await promisify(execFile)(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
  { cwd: repository }
);
