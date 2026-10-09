#!/usr/bin/env node
// Public release installer. Existing application versions and user data are never deleted.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const owner = 'SquadXO public deployment v1\n';
const entryTarget = '.squadxo/current/index.js';
const protectedRoots = new Set([
  'config.json',
  'SquadGame',
  'ServerConfig',
  'Saved',
  'Logs',
  '.squadxo',
  'node_modules',
  '.installed'
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safePath = (name) =>
  typeof name === 'string' &&
  name.length < 1024 &&
  !name.includes('\\') &&
  !name.includes('\0') &&
  name.split('/').every((part) => part && part !== '.' && part !== '..');
export function mountBoundary(path, mountInfo) {
  const target = resolve(path);
  return mountInfo.split('\n').some((line) => {
    const field = line.split(' ')[4];
    return (
      field &&
      resolve(
        field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
      ) === target
    );
  });
}
async function isMount(path) {
  return mountBoundary(path, await readFile('/proc/self/mountinfo', 'utf8'));
}
async function stat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function linkIs(path, target) {
  return (await stat(path))?.isSymbolicLink() && (await readlink(path)) === target;
}

// Parse before extracting: reject links, devices, extensions, duplicate names and traversal.
export function unpack(archive) {
  const bytes = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
  const files = new Map();
  const names = new Set();
  let end = false;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!bytes.subarray(offset).every((byte) => byte === 0))
        throw new Error('Data after tar terminator');
      end = true;
      break;
    }
    const string = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .split('\0')[0];
    const octal = (start, length) => {
      const value = string(start, length).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error('Invalid tar number');
      return Number.parseInt(value, 8);
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== octal(148, 8)) throw new Error('Invalid tar checksum');
    const prefix = string(345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${string(0, 100)}`.replace(/\/$/, '');
    const type = string(156, 1);
    const size = octal(124, 12);
    if (!safePath(name) || (!name.startsWith('squadxo/') && name !== 'squadxo') || names.has(name))
      throw new Error('Unsafe or duplicate archive path');
    names.add(name);
    if (type !== '5' && type !== '0' && type !== '')
      throw new Error('Archive must contain only files and directories');
    if ((type === '5' && size !== 0) || (name === 'squadxo' && type !== '5'))
      throw new Error('Invalid archive directory');
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw new Error('Truncated archive');
    const relative = name.slice(8);
    if (protectedRoots.has(relative.split('/')[0]))
      throw new Error(`Protected archive path: ${relative}`);
    if (type !== '5') {
      files.set(relative, bytes.subarray(offset + 512, offset + 512 + size));
    }
    offset = next;
  }
  if (!end) throw new Error('Missing tar terminator');
  for (const name of names) {
    for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) {
      if (files.has(parent.slice(8))) throw new Error('Archive file/directory collision');
    }
  }
  const sums = files.get('SHA256SUMS')?.toString('utf8');
  if (!sums) throw new Error('Missing release manifest');
  const recorded = new Set();
  for (const line of sums.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match || !safePath(match[2]) || match[2] === 'SHA256SUMS' || recorded.has(match[2]))
      throw new Error('Invalid release manifest');
    const data = files.get(match[2]);
    if (!data || digest(data) !== match[1])
      throw new Error(`Release manifest mismatch: ${match[2]}`);
    recorded.add(match[2]);
  }
  if (recorded.size !== files.size - 1) throw new Error('Unmanifested release file');
  for (const name of [
    'index.js',
    'dist/src/main.js',
    'package.json',
    'package-lock.json',
    'config.example.json',
    'BUILD_INFO.json'
  ]) {
    if (!files.has(name)) throw new Error(`Missing deployment file: ${name}`);
  }
  if (JSON.parse(files.get('package.json')).engines?.node !== '>=24 <25')
    throw new Error('Release must require Node 24');
  const info = JSON.parse(files.get('BUILD_INFO.json'));
  if (
    typeof info.version !== 'string' ||
    !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(info.version) ||
    !/^[a-f0-9]{40}$/.test(info.revision ?? '')
  )
    throw new Error('Invalid build identity');
  return files;
}

async function download(url, limit) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120000),
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Download exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function release(repo, tag) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^(latest|v[0-9A-Za-z._-]{1,64})$/.test(tag)
  )
    throw new Error('Invalid public repository or release tag');
  const metadata = JSON.parse(
    await download(
      `https://api.github.com/repos/${repo}/releases/${tag === 'latest' ? 'latest' : `tags/${tag}`}`,
      2 * 1024 * 1024
    )
  );
  if (!/^v[0-9A-Za-z._-]{1,64}$/.test(metadata.tag_name))
    throw new Error('Invalid release identity');
  const name = `squadxo-${metadata.tag_name}.tar.gz`;
  const asset = (filename) => {
    const matches = metadata.assets.filter((item) => item.name === filename);
    if (
      matches.length !== 1 ||
      matches[0].browser_download_url !==
        `https://github.com/${repo}/releases/download/${metadata.tag_name}/${filename}`
    )
      throw new Error(`Missing deployment asset: ${filename}`);
    return matches[0].browser_download_url;
  };
  return {
    archive: await download(asset(name), 64 * 1024 * 1024),
    checksum: await download(asset(`${name}.sha256`), 1024),
    name
  };
}
async function preflight(root) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Deployment root must be a real directory');
  const manager = join(root, '.squadxo');
  const managerStat = await stat(manager);
  if (managerStat) {
    if (!managerStat.isDirectory() || managerStat.dev !== rootStat.dev || (await isMount(manager)))
      throw new Error('Managed directory is a link or mount');
    const marker = await stat(join(manager, 'OWNER'));
    if (
      !marker?.isFile() ||
      marker.dev !== rootStat.dev ||
      (await readFile(join(manager, 'OWNER'), 'utf8')) !== owner
    )
      throw new Error('Managed directory collision');
    for (const name of await readdir(manager)) {
      if (!['OWNER', 'current', 'releases'].includes(name))
        throw new Error('Unknown managed directory entry');
    }
    const releases = await stat(join(manager, 'releases'));
    if (
      !releases?.isDirectory() ||
      releases.dev !== rootStat.dev ||
      (await isMount(join(manager, 'releases')))
    )
      throw new Error('Release directory collision');
    const current = await stat(join(manager, 'current'));
    if (
      current &&
      (!current.isSymbolicLink() ||
        !/^releases\/[a-f0-9-]{36}$/.test(await readlink(join(manager, 'current'))))
    )
      throw new Error('Current link collision');
  }
  const entry = join(root, 'index.js');
  if ((await stat(entry)) && (!managerStat || !(await linkIs(entry, entryTarget))))
    throw new Error('index.js collision; use an empty application entry point');
  if (await stat(join(root, '.squadxo-lock')))
    throw new Error('Installer already running or stale lock (inspect before removing)');
  return manager;
}

export async function install({
  root = process.cwd(),
  archive,
  checksum,
  name,
  npm = execute,
  rollback
}) {
  if (process.platform !== 'linux') throw new Error('Public deployment installer supports Linux');
  if (process.versions.node.split('.')[0] !== '24')
    throw new Error('Use Node.js 24 for install and startup');
  root = resolve(root);
  const manager = await preflight(root);
  let files;
  if (!rollback) {
    const match = /^([a-f0-9]{64}) {2}(squadxo-v[0-9A-Za-z._-]+\.tar\.gz)\n?$/.exec(
      checksum.toString('utf8')
    );
    if (!match || match[2] !== name || digest(archive) !== match[1])
      throw new Error('Archive checksum mismatch');
    files = unpack(archive);
    if (JSON.parse(files.get('BUILD_INFO.json')).version !== name.slice(8, -7))
      throw new Error('Archive/build version mismatch');
  } else if (!/^[a-f0-9-]{36}$/.test(rollback)) throw new Error('Invalid rollback ID');
  const lock = join(root, '.squadxo-lock');
  await mkdir(lock);
  let tempLink;
  let createdEntry = false;
  try {
    await preflightLocked(root, manager);
    if (!(await stat(manager))) {
      await mkdir(manager);
      await writeFile(join(manager, 'OWNER'), owner, { flag: 'wx' });
      await mkdir(join(manager, 'releases'));
    }
    const id = rollback ?? randomUUID();
    const target = join(manager, 'releases', id);
    if (rollback) {
      const targetStat = await lstat(target);
      if (
        !targetStat.isDirectory() ||
        targetStat.dev !== (await lstat(manager)).dev ||
        (await isMount(target))
      )
        throw new Error('Rollback target is a link or mount');
      const marker = await lstat(join(target, '.installed'));
      if (!marker.isFile() || (await readFile(join(target, '.installed'), 'utf8')) !== owner)
        throw new Error('Rollback target was not installed successfully');
      const sumsPath = join(target, 'SHA256SUMS');
      if (!(await lstat(sumsPath)).isFile()) throw new Error('Rollback manifest collision');
      for (const line of (await readFile(sumsPath, 'utf8')).trimEnd().split('\n')) {
        const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
        if (!match || !safePath(match[2])) throw new Error('Invalid rollback manifest');
        let parent = target;
        for (const part of match[2].split('/').slice(0, -1)) {
          parent = join(parent, part);
          if (!(await lstat(parent)).isDirectory() || (await isMount(parent)))
            throw new Error('Rollback link or mount boundary');
        }
        const file = join(target, match[2]);
        if (
          !(await lstat(file)).isFile() ||
          (await isMount(file)) ||
          digest(await readFile(file)) !== match[1]
        )
          throw new Error('Rollback file changed');
      }
    } else {
      await mkdir(target);
      for (const [file, data] of files) {
        await mkdir(dirname(join(target, file)), { recursive: true });
        await writeFile(join(target, file), data, { flag: 'wx', mode: 0o644 });
      }
      // Dependencies are installed only into this new release, never the running version.
      await npm('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: target,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
        maxBuffer: 8 * 1024 * 1024
      });
      await writeFile(join(target, '.installed'), owner, { flag: 'wx' });
    }
    if (!(await stat(join(root, 'index.js')))) {
      await symlink(entryTarget, join(root, 'index.js'));
      createdEntry = true;
    }
    tempLink = join(manager, `switch-${randomUUID()}`);
    await symlink(`releases/${id}`, tempLink);
    await rename(tempLink, join(manager, 'current'));
    tempLink = undefined;
    console.log(`Active SquadXO release: ${id}`);
    console.log(
      'Previous releases are retained. Configure config.json in the server root; start: node index.js --config config.json'
    );
    return id;
  } catch (error) {
    if (createdEntry && (await linkIs(join(root, 'index.js'), entryTarget)))
      await unlink(join(root, 'index.js'));
    throw error;
  } finally {
    if (tempLink) await unlink(tempLink);
    await rmdir(lock);
  }
}
async function preflightLocked(root, manager) {
  // Recheck destinations after acquiring the exclusive cooperative lock.
  if (await stat(manager)) {
    const m = await lstat(manager);
    if (
      !m.isDirectory() ||
      m.dev !== (await lstat(root)).dev ||
      !(await linkIsOrAbsent(join(root, 'index.js')))
    )
      throw new Error('Deployment destination changed');
  } else if (await stat(join(root, 'index.js'))) throw new Error('Deployment destination changed');
}
async function linkIsOrAbsent(path) {
  return !(await stat(path)) || (await linkIs(path, entryTarget));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--rollback' && args.length === 2) await install({ rollback: args[1] });
    else if (args[0] === '--archive' && args.length === 2) {
      const path = resolve(args[1]);
      await install({
        archive: await readFile(path),
        checksum: await readFile(`${path}.sha256`),
        name: path.split('/').at(-1)
      });
    } else if (args.length === 0)
      await install(
        await release(
          process.env.SQUADXO_REPO ?? 'vohk/SquadXO',
          process.env.SQUADXO_TAG ?? 'latest'
        )
      );
    else throw new Error('Usage: install.mjs [--archive FILE | --rollback RELEASE_ID]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
