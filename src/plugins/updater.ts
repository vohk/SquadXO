import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  RuntimeManagedNativePluginConfig,
  RuntimeNativePluginConfig,
  RuntimeResolvedNativePluginConfig
} from '../config/runtime-config.js';
import {
  createNativePluginPlan,
  mountNativePlugin,
  type NativePluginPlan,
  type PlannedNativePlugin
} from './loader.js';
import type { PluginRuntime } from './runtime.js';

const STATE_VERSION = 1;
const MAX_PLUGIN_BYTES = 5 * 1024 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
const INITIAL_CHECK_DELAY_MS = 5 * 60 * 1000;

interface CachedRevision {
  readonly revision: string;
  readonly sha256: string;
}

interface ManagedPluginState {
  readonly formatVersion: typeof STATE_VERSION;
  readonly source: string;
  active?: CachedRevision | undefined;
  previous?: CachedRevision | undefined;
  staged?: CachedRevision | undefined;
  trial?: CachedRevision | undefined;
  lastCheckedAt?: string | undefined;
  lastUpdatedAt?: string | undefined;
  lastError?: string | undefined;
}

export interface NativePluginUpdateHealth {
  readonly activeRevision?: string;
  readonly stagedRevision?: string;
  readonly lastCheckedAt?: string;
  readonly lastUpdatedAt?: string;
  readonly lastError?: string;
}

interface UpdaterOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly logger?: (plugin: string, level: 'info' | 'warn' | 'error', message: string) => void;
}

interface GitHubContentsResponse {
  readonly type?: unknown;
  readonly sha?: unknown;
  readonly encoding?: unknown;
  readonly content?: unknown;
}

export class NativePluginUpdater {
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #logger: NonNullable<UpdaterOptions['logger']>;
  readonly #configs = new Map<string, RuntimeManagedNativePluginConfig>();
  readonly #states = new Map<string, ManagedPluginState>();
  readonly #plans = new Map<string, PlannedNativePlugin>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #runtime: PluginRuntime | undefined;
  #abort = new AbortController();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: UpdaterOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#token = options.token ?? process.env.SQUADJS_GITHUB_TOKEN;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#logger = options.logger ?? (() => undefined);
  }

  async resolve(
    configs: readonly RuntimeNativePluginConfig[]
  ): Promise<RuntimeResolvedNativePluginConfig[]> {
    const resolved: RuntimeResolvedNativePluginConfig[] = [];
    this.#configs.clear();
    this.#states.clear();
    for (const config of configs.filter((entry) => entry.enabled)) {
      if (!isManaged(config)) {
        resolved.push(config);
        continue;
      }
      this.#configs.set(config.name, config);
      let state = await this.#readState(config);
      if (state.trial) {
        state = {
          ...state,
          staged: undefined,
          trial: undefined,
          lastError: 'The previous staged revision did not complete startup and was rolled back.'
        };
        await this.#writeState(config, state);
      }
      if (state.staged && state.staged.revision !== state.active?.revision) {
        state = { ...state, trial: state.staged };
        await this.#writeState(config, state);
      }
      let selected = state.trial ?? state.active;
      if (!selected) {
        const downloaded = await this.#download(config);
        if (!downloaded) throw new Error('Initial managed plugin download returned no revision');
        selected = downloaded;
        state = {
          ...state,
          trial: downloaded,
          lastCheckedAt: this.#now().toISOString(),
          lastError: undefined
        };
        await this.#writeState(config, state);
      }
      await this.#verifyCachedRevision(config, selected);
      this.#states.set(config.name, state);
      resolved.push(this.#resolvedConfig(config, selected));
    }
    return resolved;
  }

  bind(runtime: PluginRuntime, plan: NativePluginPlan): void {
    this.#runtime = runtime;
    this.#plans.clear();
    for (const plugin of plan.plugins) this.#plans.set(plugin.name, plugin);
  }

  async markStartupHealthy(): Promise<void> {
    for (const config of this.#configs.values()) {
      const state = this.#states.get(config.name);
      if (!state?.trial) continue;
      const promoted: ManagedPluginState = {
        ...state,
        active: state.trial,
        previous: state.active,
        staged: undefined,
        trial: undefined,
        lastUpdatedAt: this.#now().toISOString(),
        lastError: undefined
      };
      await this.#writeState(config, promoted);
      this.#states.set(config.name, promoted);
      await this.#pruneRevisions(config, promoted);
    }
  }

  async rollbackStartup(error: unknown): Promise<void> {
    const detail = errorMessage(error);
    for (const config of this.#configs.values()) {
      const state = this.#states.get(config.name);
      if (!state?.trial) continue;
      const rolledBack: ManagedPluginState = {
        ...state,
        staged: undefined,
        trial: undefined,
        lastError: `Staged revision failed startup: ${detail}`
      };
      await this.#writeState(config, rolledBack);
      this.#states.set(config.name, rolledBack);
    }
  }

  start(): void {
    this.#abort = new AbortController();
    for (const config of this.#configs.values()) {
      if (!config.updates.enabled) continue;
      const maximumInitialDelay = Math.min(
        INITIAL_CHECK_DELAY_MS,
        config.updates.intervalMinutes * 60_000
      );
      this.#schedule(config, Math.floor(this.#random() * maximumInitialDelay));
    }
  }

  async checkNow(name?: string): Promise<void> {
    const configs = name
      ? [this.#requiredConfig(name)]
      : [...this.#configs.values()].filter((config) => config.updates.enabled);
    const operation = this.#queue.then(async () => {
      for (const config of configs) await this.#check(config);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await this.#queue;
    this.#runtime = undefined;
    this.#plans.clear();
  }

  health(): Readonly<Record<string, NativePluginUpdateHealth>> {
    return Object.fromEntries(
      [...this.#states.entries()].map(([name, state]) => [
        name,
        {
          ...(state.active ? { activeRevision: state.active.revision } : {}),
          ...(state.staged ? { stagedRevision: state.staged.revision } : {}),
          ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
          ...(state.lastUpdatedAt ? { lastUpdatedAt: state.lastUpdatedAt } : {}),
          ...(state.lastError ? { lastError: state.lastError } : {})
        }
      ])
    );
  }

  #schedule(config: RuntimeManagedNativePluginConfig, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(config.name);
      void this.checkNow(config.name)
        .catch((error: unknown) => {
          this.#logger(config.name, 'error', `Update check failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          if (this.#abort.signal.aborted) return;
          const interval = config.updates.intervalMinutes * 60_000;
          const jitter = Math.floor(interval * 0.1 * this.#random());
          this.#schedule(config, interval + jitter);
        });
    }, delayMs);
    timer.unref?.();
    this.#timers.set(config.name, timer);
  }

  async #check(config: RuntimeManagedNativePluginConfig): Promise<void> {
    const state = this.#states.get(config.name) ?? (await this.#readState(config));
    try {
      const candidate = await this.#download(config, state.active?.revision);
      const checked = {
        ...state,
        lastCheckedAt: this.#now().toISOString(),
        lastError: undefined
      };
      if (!candidate) {
        await this.#writeState(config, checked);
        this.#states.set(config.name, checked);
        return;
      }
      this.#logger(
        config.name,
        'info',
        `Update detected: ${shortRevision(state.active?.revision)} -> ${shortRevision(candidate.revision)}`
      );
      const candidateConfig = this.#resolvedConfig(config, candidate);
      const candidatePlan = await createNativePluginPlan([candidateConfig]);
      const candidatePlugin = candidatePlan.plugins[0];
      if (!candidatePlugin) throw new Error('Downloaded plugin did not produce a native plan');
      const currentPlan = this.#plans.get(config.name);
      if (!currentPlan) throw new Error('Current plugin plan is unavailable');
      if (connectorSignature(candidatePlugin) !== connectorSignature(currentPlan)) {
        throw new Error('connector requirements changed; update requires a configured restart');
      }
      if (config.updates.apply === 'restart') {
        const staged: ManagedPluginState = {
          ...checked,
          staged: candidate,
          lastError: undefined
        };
        await this.#writeState(config, staged);
        this.#states.set(config.name, staged);
        this.#logger(config.name, 'info', 'Update staged for the next restart.');
        return;
      }
      const applying: ManagedPluginState = {
        ...checked,
        trial: candidate,
        lastError: undefined
      };
      await this.#writeState(config, applying);
      this.#states.set(config.name, applying);
      try {
        await this.#hotReplace(config, currentPlan, candidatePlugin);
      } catch (error) {
        const rolledBack: ManagedPluginState = {
          ...checked,
          trial: undefined,
          lastError: errorMessage(error)
        };
        await this.#writeState(config, rolledBack);
        this.#states.set(config.name, rolledBack);
        throw error;
      }
      this.#plans.set(config.name, candidatePlugin);
      const updated: ManagedPluginState = {
        ...checked,
        active: candidate,
        previous: state.active,
        staged: undefined,
        trial: undefined,
        lastUpdatedAt: this.#now().toISOString(),
        lastError: undefined
      };
      await this.#writeState(config, updated);
      this.#states.set(config.name, updated);
      await this.#pruneRevisions(config, updated);
      this.#logger(config.name, 'info', 'Hot reload completed.');
    } catch (error) {
      const latestState = this.#states.get(config.name) ?? state;
      const failed: ManagedPluginState = {
        ...latestState,
        lastCheckedAt: this.#now().toISOString(),
        lastError: errorMessage(error)
      };
      await this.#writeState(config, failed);
      this.#states.set(config.name, failed);
      throw error;
    }
  }

  async #hotReplace(
    config: RuntimeManagedNativePluginConfig,
    current: PlannedNativePlugin,
    candidate: PlannedNativePlugin
  ): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) throw new Error('Native plugin runtime is unavailable');
    try {
      await runtime.unmount(config.name);
    } catch (unmountError) {
      try {
        await mountNativePlugin(runtime, current);
      } catch (rollbackError) {
        throw new AggregateError(
          [unmountError, rollbackError],
          'Update cleanup failed and the previous plugin could not be remounted'
        );
      }
      throw new Error(`Current plugin could not be unmounted: ${errorMessage(unmountError)}`, {
        cause: unmountError
      });
    }
    try {
      await mountNativePlugin(runtime, candidate);
    } catch (updateError) {
      try {
        await mountNativePlugin(runtime, current);
      } catch (rollbackError) {
        throw new AggregateError(
          [updateError, rollbackError],
          'Updated plugin failed to mount and rollback also failed'
        );
      }
      throw new Error(
        `Updated plugin failed to mount; rollback succeeded: ${errorMessage(updateError)}`,
        {
          cause: updateError
        }
      );
    }
  }

  async #download(
    config: RuntimeManagedNativePluginConfig,
    currentRevision?: string
  ): Promise<CachedRevision | undefined> {
    const source = config.source;
    const encodedPath = source.path.split('/').map(encodeURIComponent).join('/');
    const url =
      `https://api.github.com/repos/${source.repository}/contents/${encodedPath}` +
      `?ref=${encodeURIComponent(source.ref)}`;
    const metadata = (await this.#fetchJson(url)) as GitHubContentsResponse;
    if (metadata.type !== 'file') throw new Error('Configured GitHub path is not a file');
    if (typeof metadata.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(metadata.sha)) {
      throw new Error('GitHub returned an invalid blob revision');
    }
    const revision = metadata.sha.toLowerCase();
    if (revision === currentRevision) return undefined;
    let encodedContent =
      metadata.encoding === 'base64' && typeof metadata.content === 'string'
        ? metadata.content
        : undefined;
    if (!encodedContent) {
      const blob = (await this.#fetchJson(
        `https://api.github.com/repos/${source.repository}/git/blobs/${revision}`
      )) as GitHubContentsResponse;
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
        throw new Error('GitHub did not return base64 plugin content');
      }
      encodedContent = blob.content;
    }
    const contents = Buffer.from(encodedContent.replace(/\s/g, ''), 'base64');
    if (contents.length === 0) throw new Error('Downloaded plugin is empty');
    if (contents.length > MAX_PLUGIN_BYTES) {
      throw new Error(`Downloaded plugin exceeds ${MAX_PLUGIN_BYTES} bytes`);
    }
    if (revision.length === 40 && gitBlobSha(contents) !== revision) {
      throw new Error('Downloaded plugin does not match its GitHub blob revision');
    }
    const cached = {
      revision,
      sha256: createHash('sha256').update(contents).digest('hex')
    };
    await this.#writeRevision(config, cached, contents);
    return cached;
  }

  async #fetchJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SquadXO-native-plugin-updater',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    const response = await this.#fetch(url, {
      headers,
      signal: this.#abort.signal
    });
    if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}`);
    const bytes = await readLimitedResponse(response, MAX_GITHUB_RESPONSE_BYTES);
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new Error('GitHub returned invalid JSON');
    }
  }

  #resolvedConfig(
    config: RuntimeManagedNativePluginConfig,
    revision: CachedRevision
  ): RuntimeResolvedNativePluginConfig {
    return {
      type: 'native',
      name: config.name,
      module: `github:${config.source.repository}/${config.source.path}@${revision.revision}`,
      modulePath: this.#revisionPath(config, revision.revision),
      enabled: config.enabled,
      options: config.options,
      connectors: config.connectors
    };
  }

  async #readState(config: RuntimeManagedNativePluginConfig): Promise<ManagedPluginState> {
    const expectedSource = sourceKey(config);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#statePath(config), 'utf8')) as unknown;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return { formatVersion: STATE_VERSION, source: expectedSource };
      }
      throw new Error(`Could not read managed plugin state: ${errorMessage(error)}`, {
        cause: error
      });
    }
    if (!isRecord(parsed) || parsed.formatVersion !== STATE_VERSION) {
      throw new Error('Managed plugin state has an unsupported format');
    }
    if (parsed.source !== expectedSource) {
      return { formatVersion: STATE_VERSION, source: expectedSource };
    }
    const state: ManagedPluginState = {
      formatVersion: STATE_VERSION,
      source: expectedSource,
      ...(readCachedRevision(parsed.active, 'active')
        ? { active: readCachedRevision(parsed.active, 'active') }
        : {}),
      ...(readCachedRevision(parsed.previous, 'previous')
        ? { previous: readCachedRevision(parsed.previous, 'previous') }
        : {}),
      ...(readCachedRevision(parsed.staged, 'staged')
        ? { staged: readCachedRevision(parsed.staged, 'staged') }
        : {}),
      ...(readCachedRevision(parsed.trial, 'trial')
        ? { trial: readCachedRevision(parsed.trial, 'trial') }
        : {}),
      ...(typeof parsed.lastCheckedAt === 'string' ? { lastCheckedAt: parsed.lastCheckedAt } : {}),
      ...(typeof parsed.lastUpdatedAt === 'string' ? { lastUpdatedAt: parsed.lastUpdatedAt } : {}),
      ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {})
    };
    this.#states.set(config.name, state);
    return state;
  }

  async #writeState(
    config: RuntimeManagedNativePluginConfig,
    state: ManagedPluginState
  ): Promise<void> {
    const path = this.#statePath(config);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(compactState(state), null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #writeRevision(
    config: RuntimeManagedNativePluginConfig,
    revision: CachedRevision,
    contents: Buffer
  ): Promise<void> {
    const path = this.#revisionPath(config, revision.revision);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
      await this.#verifyCachedRevision(config, revision);
    }
  }

  async #verifyCachedRevision(
    config: RuntimeManagedNativePluginConfig,
    revision: CachedRevision
  ): Promise<void> {
    const path = this.#revisionPath(config, revision.revision);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_PLUGIN_BYTES) {
      throw new Error(`Cached plugin revision is invalid: ${revision.revision}`);
    }
    const digest = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (digest !== revision.sha256) {
      throw new Error(
        `Cached plugin revision failed its local SHA-256 check: ${revision.revision}`
      );
    }
  }

  async #pruneRevisions(
    config: RuntimeManagedNativePluginConfig,
    state: ManagedPluginState
  ): Promise<void> {
    const retained = new Set(
      [state.active, state.previous, state.staged, state.trial]
        .filter((revision): revision is CachedRevision => Boolean(revision))
        .map((revision) => revision.revision)
    );
    const revisionsPath = join(config.storagePath, 'revisions');
    let entries;
    try {
      entries = await readdir(revisionsPath, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || retained.has(entry.name)) continue;
      if (!/^[a-f0-9]{40,64}$/i.test(entry.name)) continue;
      await rm(join(revisionsPath, entry.name), {
        recursive: true,
        force: true
      });
    }
  }

  #revisionPath(config: RuntimeManagedNativePluginConfig, revision: string): string {
    return join(config.storagePath, 'revisions', revision, 'plugin.mjs');
  }

  #statePath(config: RuntimeManagedNativePluginConfig): string {
    return join(config.storagePath, 'state.json');
  }

  #requiredConfig(name: string): RuntimeManagedNativePluginConfig {
    const config = this.#configs.get(name);
    if (!config) throw new Error(`Managed native plugin is not configured: ${name}`);
    if (!config.updates.enabled) throw new Error(`Native plugin updates are disabled: ${name}`);
    return config;
  }
}

function isManaged(config: RuntimeNativePluginConfig): config is RuntimeManagedNativePluginConfig {
  return 'source' in config;
}

function sourceKey(config: RuntimeManagedNativePluginConfig): string {
  return `${config.source.provider}:${config.source.repository}:${config.source.ref}:${config.source.path}`;
}

function connectorSignature(plugin: PlannedNativePlugin): string {
  return JSON.stringify(
    Object.entries(plugin.connectors)
      .map(([alias, name]) => ({
        alias,
        name,
        type: plugin.definition.connectors[alias]?.type
      }))
      .sort((left, right) => left.alias.localeCompare(right.alias))
  );
}

function compactState(state: ManagedPluginState): ManagedPluginState {
  return JSON.parse(JSON.stringify(state)) as ManagedPluginState;
}

function readCachedRevision(value: unknown, label: string): CachedRevision | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{40,64}$/i.test(value.revision) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.sha256)
  ) {
    throw new Error(`Managed plugin state has an invalid ${label} revision`);
  }
  return {
    revision: value.revision.toLowerCase(),
    sha256: value.sha256.toLowerCase()
  };
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`GitHub response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error(`GitHub response exceeds ${maximumBytes} bytes`);
    chunks.push(chunk);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function shortRevision(revision: string | undefined): string {
  return revision?.slice(0, 8) ?? 'none';
}

function gitBlobSha(contents: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`blob ${contents.length}\0`, 'utf8'))
    .update(contents)
    .digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
