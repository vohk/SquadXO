import { createReadStream, createWriteStream } from 'node:fs';
import { type FileHandle, mkdir, open, readdir, lstat, unlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

// Each process instance owns a dedicated directory. No existing archive is reopened or overwritten.
const ownedDirectories = new Set<string>();
const FILE = /^rcon-\d{4}-\d\d-\d\dT\d\d-[0-9a-f-]{36}\.jsonl(?:\.gz(?:\.tmp)?)?$/;
const MB = 1024 * 1024;

export interface RecorderStorageOptions {
  readonly directory: string;
  readonly retentionDays: number;
  readonly maxTotalMB: number;
  readonly maxFileMB: number;
  readonly maxBufferMB: number;
  readonly maxEntryKB: number;
  readonly maxDedupEntries: number;
  readonly compress: boolean;
}

export interface RecorderStats {
  readonly written: number;
  readonly dropped: number;
  readonly overflow: number;
  readonly oversized: number;
  readonly ioErrors: number;
}

interface FileInfo {
  size: number;
  modified: number;
}
interface Entry {
  readonly line: string;
  readonly bytes: number;
  readonly time: Date;
  readonly commandKey?: string;
  readonly responseKey?: string;
}

/** Bounded, single-worker storage: writes, rotation, compression and pruning never overlap. */
export class RecorderStore {
  readonly directory: string;
  readonly #options: RecorderStorageOptions;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #track: (task: Promise<void>) => void;
  readonly #files = new Map<string, FileInfo>();
  readonly #queue: (Entry | 'maintenance')[] = [];
  readonly #responses = new Map<string, string>();
  readonly #stats = { written: 0, dropped: 0, overflow: 0, oversized: 0, ioErrors: 0 };
  #total = 0;
  #inventoryValid = false;
  #buffered = 0;
  #accepting = false;
  #claimed = false;
  #worker: Promise<void> | undefined;
  #active: { name: string; handle: FileHandle; hour: string } | undefined;

  constructor(
    options: RecorderStorageOptions,
    onError: (error: unknown) => void,
    now = () => new Date(),
    track: (task: Promise<void>) => void = () => undefined
  ) {
    this.#options = options;
    this.directory = resolve(options.directory);
    this.#onError = (error) => {
      try {
        onError(error);
      } catch {
        /* diagnostics must not interrupt storage cleanup */
      }
    };
    this.#track = track;
    this.#now = now;
    for (const [name, value] of Object.entries(options)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) {
        throw new TypeError(`${name} must be a positive finite number`);
      }
    }
    if (!options.directory.trim()) throw new TypeError('directory must not be empty');
    if (options.maxEntryKB < 1) throw new TypeError('maxEntryKB must be at least 1');
    if (!Number.isInteger(options.maxDedupEntries))
      throw new TypeError('maxDedupEntries must be an integer');
    if (options.maxFileMB > options.maxTotalMB)
      throw new TypeError('maxFileMB must not exceed maxTotalMB');
    if (options.maxEntryKB * 1024 > Math.min(options.maxFileMB, options.maxBufferMB) * MB) {
      throw new TypeError('maxEntryKB must fit both maxFileMB and maxBufferMB');
    }
  }

  get stats(): RecorderStats {
    return { ...this.#stats };
  }

  async start(): Promise<void> {
    if (this.#claimed || ownedDirectories.has(this.directory)) {
      throw new Error('RconRecorder needs a dedicated directory per instance');
    }
    ownedDirectories.add(this.directory);
    this.#claimed = true;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.#scan();
      await this.#prune(0);
      if (this.#options.compress) {
        for (const name of [...this.#files.keys()]) {
          if (name.endsWith('.jsonl')) await this.#compress(name);
        }
      }
      this.#accepting = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** Caller supplies bounded fields; the serialized limit is enforced again here. */
  enqueue(
    record: Record<string, unknown>,
    time: Date,
    keys?: { command: string; response: string }
  ): boolean {
    if (!this.#accepting) return false;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (!Number.isFinite(time.getTime()) || bytes > this.#options.maxEntryKB * 1024) {
      this.#drop('oversized');
      return false;
    }
    if (this.#buffered + bytes > this.#options.maxBufferMB * MB || this.#queue.length >= 4096) {
      this.#drop('overflow');
      return false;
    }
    this.#queue.push({
      line,
      bytes,
      time,
      ...(keys ? { commandKey: keys.command, responseKey: keys.response } : {})
    });
    this.#buffered += bytes;
    this.#schedule();
    return true;
  }

  maintain(): Promise<void> {
    if (this.#accepting && !this.#queue.includes('maintenance')) {
      this.#queue.push('maintenance');
      this.#schedule();
    }
    return this.idle();
  }

  async idle(): Promise<void> {
    while (this.#worker) await this.#worker;
  }

  async stop(): Promise<void> {
    this.#accepting = false;
    try {
      await this.idle();
      await this.#close();
    } finally {
      if (this.#claimed) ownedDirectories.delete(this.directory);
      this.#claimed = false;
      this.#responses.clear();
    }
  }

  #drop(reason: 'overflow' | 'oversized'): void {
    this.#stats.dropped++;
    this.#stats[reason]++;
    // A lost entry invalidates references to earlier responses for replay purposes.
    this.#responses.clear();
  }

  #schedule(): void {
    if (this.#worker) return;
    this.#worker = Promise.resolve()
      .then(() => this.#drain())
      .finally(() => {
        this.#worker = undefined;
        if (this.#queue.length) this.#schedule();
      });
    this.#track(this.#worker);
  }

  async #drain(): Promise<void> {
    while (this.#queue.length) {
      const entry = this.#queue.shift()!;
      try {
        if (entry === 'maintenance') {
          if (this.#active && this.#active.hour !== this.#now().toISOString().slice(0, 13))
            await this.#close();
          await this.#prune(0);
        } else {
          await this.#write(entry);
        }
      } catch (error) {
        this.#stats.ioErrors++;
        if (entry !== 'maintenance') this.#stats.dropped++;
        this.#responses.clear();
        this.#onError(error);
        // Reconcile partial writes; next entry retries with a new file, without dangling JSON.
        const active = this.#active;
        this.#active = undefined;
        if (active) {
          try {
            await active.handle.truncate(this.#files.get(active.name)?.size ?? 0);
          } catch {
            /* account actual size below */
          }
          try {
            await active.handle.close();
          } catch {
            /* already closed */
          }
          if ((this.#files.get(active.name)?.size ?? 0) === 0) {
            await unlink(join(this.directory, active.name)).catch(() => undefined);
          }
        }
        await this.#scan().catch(this.#onError);
      } finally {
        if (entry !== 'maintenance') this.#buffered -= entry.bytes;
      }
    }
  }

  async #write(entry: Entry): Promise<void> {
    if (!this.#inventoryValid) await this.#scan();
    const hour = entry.time.toISOString().slice(0, 13);
    const currentSize = this.#active ? this.#files.get(this.#active.name)!.size : 0;
    if (
      this.#active &&
      (hour !== this.#active.hour || currentSize + entry.bytes > this.#options.maxFileMB * MB)
    ) {
      await this.#close();
    }
    if (!this.#active) {
      const name = `rcon-${hour}-${randomUUID()}.jsonl`;
      const handle = await open(join(this.directory, name), 'wx', 0o600);
      this.#active = { name, handle, hour };
      this.#files.set(name, { size: 0, modified: this.#now().getTime() });
      this.#responses.clear();
    }
    let line = entry.line;
    if (
      entry.commandKey &&
      entry.responseKey &&
      this.#responses.get(entry.commandKey) === entry.responseKey
    ) {
      const record = JSON.parse(line) as Record<string, unknown>;
      delete record.response;
      record.same = true;
      line = `${JSON.stringify(record)}\n`;
    }
    const bytes = Buffer.byteLength(line);
    if (!(await this.#prune(bytes)))
      throw new Error('RconRecorder storage limit has no room for this entry');
    await this.#active.handle.writeFile(line, 'utf8');
    const info = this.#files.get(this.#active.name)!;
    info.size += bytes;
    info.modified = this.#now().getTime();
    this.#total += bytes;
    this.#stats.written++;
    if (entry.commandKey && entry.responseKey) {
      this.#responses.delete(entry.commandKey);
      this.#responses.set(entry.commandKey, entry.responseKey);
      if (this.#responses.size > this.#options.maxDedupEntries)
        this.#responses.delete(this.#responses.keys().next().value!);
    }
  }

  async #close(): Promise<void> {
    const active = this.#active;
    this.#active = undefined;
    this.#responses.clear();
    if (!active) return;
    try {
      await active.handle.sync();
    } finally {
      await active.handle.close();
    }
    if (this.#options.compress) await this.#compress(active.name);
  }

  async #compress(name: string): Promise<void> {
    const info = this.#files.get(name);
    if (!info || info.size === 0 || this.#files.has(`${name}.gz`)) return;
    // Reserve a conservative gzip bound, including the source AND scratch file in the cap.
    const reserve = info.size + Math.ceil(info.size / 1024) * 16 + 1024;
    if (!(await this.#prune(reserve, name))) return; // Keep JSONL when compression cannot fit.
    const temporary = `${name}.gz.tmp`;
    let outputBytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        outputBytes += chunk.length;
        if (outputBytes > reserve)
          callback(new Error('Compressed recording exceeded reserved space'));
        else callback(null, chunk);
      }
    });
    try {
      await pipeline(
        createReadStream(join(this.directory, name)),
        createGzip(),
        limit,
        createWriteStream(join(this.directory, temporary), { flags: 'wx', mode: 0o600 })
      );
      await rename(join(this.directory, temporary), join(this.directory, `${name}.gz`));
      this.#files.set(`${name}.gz`, { size: outputBytes, modified: info.modified });
      this.#total += outputBytes;
      await this.#remove(name);
    } catch (error) {
      await unlink(join(this.directory, temporary)).catch(() => undefined);
      throw error;
    }
  }

  async #scan(): Promise<void> {
    this.#inventoryValid = false;
    this.#files.clear();
    this.#total = 0;
    for (const name of await readdir(this.directory)) {
      if (!FILE.test(name)) continue;
      const info = await lstat(join(this.directory, name));
      if (!info.isFile()) continue;
      if (name.endsWith('.tmp')) {
        await unlink(join(this.directory, name));
        continue;
      }
      this.#files.set(name, { size: info.size, modified: info.mtimeMs });
      this.#total += info.size;
    }
    this.#inventoryValid = true;
  }

  async #prune(required: number, protectedName?: string): Promise<boolean> {
    const cutoff = this.#now().getTime() - this.#options.retentionDays * 86400_000;
    for (const [name, info] of [...this.#files].sort((a, b) => a[1].modified - b[1].modified)) {
      if (name === this.#active?.name || name === protectedName) continue;
      if (
        info.modified < cutoff ||
        this.#total + required > this.#options.maxTotalMB * MB ||
        this.#files.size > 1024
      )
        await this.#remove(name);
    }
    return this.#total + required <= this.#options.maxTotalMB * MB;
  }

  async #remove(name: string): Promise<void> {
    await unlink(join(this.directory, name));
    this.#total -= this.#files.get(name)?.size ?? 0;
    this.#files.delete(name);
  }
}
