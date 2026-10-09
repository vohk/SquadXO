import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface AdminListSource {
  readonly type: 'local' | 'remote';
  readonly source: string;
}

export interface AdminListLoadResult {
  readonly admins: Readonly<Record<string, Readonly<Record<string, true>>>>;
  readonly loadedSources: number;
  readonly errors: readonly Error[];
}

export async function loadAdminLists(
  sources: readonly AdminListSource[],
  options: {
    readonly fetch?: typeof fetch;
    readonly baseDirectory?: string;
    readonly timeoutMs?: number;
  } = {}
): Promise<AdminListLoadResult> {
  const fetchImplementation = options.fetch ?? fetch;
  const baseDirectory = options.baseDirectory ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const admins: Record<string, Record<string, true>> = {};
  const errors: Error[] = [];
  let loadedSources = 0;

  for (const [index, source] of sources.entries()) {
    try {
      const contents =
        source.type === 'local'
          ? await readFile(resolve(baseDirectory, source.source), 'utf8')
          : await fetchRemote(fetchImplementation, source.source, timeoutMs);
      const sourceAdmins: Record<string, Record<string, true>> = {};
      mergeAdminList(sourceAdmins, contents, index);
      mergeAdmins(admins, sourceAdmins);
      loadedSources += 1;
    } catch (error) {
      errors.push(
        new Error(
          `Admin list ${index + 1} (${source.type}:${displaySource(source.source)}) failed`,
          {
            cause: error
          }
        )
      );
    }
  }

  return { admins, loadedSources, errors };
}

export function parseAdminListSources(value: unknown): readonly AdminListSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('config.server.adminLists: expected an array');
  const sources: AdminListSource[] = [];
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`config.server.adminLists[${index}]: expected an object`);
    }
    const record = entry as Record<string, unknown>;
    if ((record.type === '' || record.type === undefined) && !record.source) continue;
    if (record.type !== 'local' && record.type !== 'remote') {
      throw new TypeError(`config.server.adminLists[${index}].type: expected local or remote`);
    }
    if (typeof record.source !== 'string' || !record.source.trim()) {
      throw new TypeError(`config.server.adminLists[${index}].source: expected a string`);
    }
    sources.push({ type: record.type, source: record.source });
  }
  return sources;
}

async function fetchRemote(
  fetchImplementation: typeof fetch,
  source: string,
  timeoutMs: number
): Promise<string> {
  const url = new URL(source);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Remote admin list source must use http:// or https://');
  }
  const response = await fetchImplementation(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

function mergeAdminList(
  admins: Record<string, Record<string, true>>,
  contents: string,
  sourceIndex: number
): void {
  const groups = new Map<string, readonly string[]>();
  const pendingAdmins: { readonly id: string; readonly group: string }[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+\/\/.*$/, '').trim();
    if (!line) continue;
    const group = line.match(/^Group=([^:]+):(.*)$/);
    if (group?.[1] !== undefined) {
      groups.set(
        group[1],
        (group[2] ?? '')
          .split(',')
          .map((permission) => permission.trim().toLowerCase())
          .filter(Boolean)
      );
      continue;
    }
    const admin = line.match(/^Admin=(\d{17}|[0-9a-f]{32}):(\S+)$/i);
    if (admin?.[1] && admin[2]) {
      pendingAdmins.push({ id: admin[1].toLowerCase(), group: admin[2] });
    }
  }

  for (const admin of pendingAdmins) {
    const permissions = groups.get(admin.group);
    if (!permissions) {
      throw new Error(
        `Admin ${admin.id} references unknown group ${admin.group} in source ${sourceIndex + 1}`
      );
    }
    const existing = admins[admin.id] ?? {};
    for (const permission of permissions) existing[permission] = true;
    admins[admin.id] = existing;
  }
}

function mergeAdmins(
  target: Record<string, Record<string, true>>,
  source: Readonly<Record<string, Readonly<Record<string, true>>>>
): void {
  for (const [id, permissions] of Object.entries(source)) {
    target[id] = { ...target[id], ...permissions };
  }
}

function displaySource(source: string): string {
  try {
    const url = new URL(source);
    url.username = '';
    url.password = '';
    if (url.search) url.search = '?[redacted]';
    return url.toString();
  } catch {
    return source;
  }
}
