import { createWriteStream } from 'node:fs';
import { open, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type {
  LogLineHandler,
  LogReader,
  LogReaderHealth,
  LogSnapshot,
  LogSnapshotOptions
} from './reader.js';

export interface LocalTailReaderOptions {
  readonly path: string;
  readonly startAt?: 'beginning' | 'end';
  readonly pollIntervalMs?: number;
  readonly readBufferSize?: number;
  readonly onReplacement?: (reason: 'path-replaced' | 'file-shrank') => void;
  readonly onError?: (error: Error) => void;
}

export class LocalTailReader implements LogReader {
  readonly #options: {
    readonly path: string;
    readonly startAt: 'beginning' | 'end';
    readonly pollIntervalMs: number;
    readonly readBufferSize: number;
    readonly onReplacement: LocalTailReaderOptions['onReplacement'] | undefined;
    readonly onError: LocalTailReaderOptions['onError'] | undefined;
  };
  #handler: LogLineHandler | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #reading = false;
  #offset = 0;
  #device: number | undefined;
  #inode: number | undefined;
  #partial = '';
  #lastLineAt: Date | undefined;
  #replacements = 0;

  constructor(options: LocalTailReaderOptions) {
    this.#options = {
      path: options.path,
      startAt: options.startAt ?? 'end',
      pollIntervalMs: options.pollIntervalMs ?? 250,
      readBufferSize: options.readBufferSize ?? 64 * 1024,
      onReplacement: options.onReplacement,
      onError: options.onError
    };
  }

  async start(handler: LogLineHandler): Promise<void> {
    if (this.#running) throw new Error('Local log reader is already running');
    this.#handler = handler;
    this.#partial = '';
    try {
      const file = await stat(this.#options.path);
      this.#device = file.dev;
      this.#inode = file.ino;
      this.#offset = this.#options.startAt === 'end' ? file.size : 0;
      this.#running = true;
      await this.#poll();
      this.#timer = setInterval(
        () => void this.#poll().catch((error: unknown) => this.#reportError(error)),
        this.#options.pollIntervalMs
      );
    } catch (error) {
      this.#running = false;
      this.#handler = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    while (this.#reading) await new Promise((resolve) => setTimeout(resolve, 1));
    this.#handler = undefined;
  }

  health(): LogReaderHealth {
    return {
      running: this.#running,
      source: this.#options.path,
      offset: this.#offset,
      ...(this.#lastLineAt ? { lastLineAt: this.#lastLineAt } : {}),
      replacements: this.#replacements
    };
  }

  async copySnapshot(destination: string, options: LogSnapshotOptions): Promise<LogSnapshot> {
    validateSnapshotOptions(options);
    throwIfAborted(options.signal);
    const source = await open(this.#options.path, 'r');
    try {
      const metadata = await source.stat();
      if (!metadata.isFile()) throw new Error('Squad log source is not a regular file');
      if (metadata.size > options.maximumBytes) {
        throw new Error(
          `Squad log is ${metadata.size} bytes; configured maximum is ${options.maximumBytes} bytes`
        );
      }
      if (metadata.size === 0) {
        await writeFile(destination, new Uint8Array(), { flag: 'wx' });
      } else {
        const input = source.createReadStream({
          start: 0,
          end: metadata.size - 1,
          autoClose: false
        });
        const output = createWriteStream(destination, { flags: 'wx' });
        if (options.signal) await pipeline(input, output, { signal: options.signal });
        else await pipeline(input, output);
      }
      return { sourceBytes: metadata.size, modifiedAt: metadata.mtime };
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await source.close();
    }
  }

  async #poll(): Promise<void> {
    if (!this.#running || this.#reading || !this.#handler) return;
    this.#reading = true;
    try {
      const file = await stat(this.#options.path);
      const replaced = file.dev !== this.#device || file.ino !== this.#inode;
      const shrank = file.size < this.#offset;
      if (replaced || shrank) {
        this.#device = file.dev;
        this.#inode = file.ino;
        this.#offset = 0;
        this.#partial = '';
        this.#replacements += 1;
        this.#options.onReplacement?.(replaced ? 'path-replaced' : 'file-shrank');
      }
      if (file.size > this.#offset) await this.#readTo(file.size, this.#handler);
    } finally {
      this.#reading = false;
    }
  }

  async #readTo(targetSize: number, handler: LogLineHandler): Promise<void> {
    const handle = await open(this.#options.path, 'r');
    const decoder = new StringDecoder('utf8');
    try {
      while (this.#running && this.#offset < targetSize) {
        const length = Math.min(this.#options.readBufferSize, targetSize - this.#offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
        if (bytesRead === 0) break;
        this.#offset += bytesRead;
        const text = this.#partial + decoder.write(buffer.subarray(0, bytesRead));
        const lines = text.split(/\r?\n/);
        this.#partial = lines.pop() ?? '';
        for (const line of lines) {
          await handler(line);
          this.#lastLineAt = new Date();
        }
      }
      this.#partial += decoder.end();
    } finally {
      await handle.close();
    }
  }

  #reportError(error: unknown): void {
    this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function validateSnapshotOptions(options: LogSnapshotOptions): void {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1) {
    throw new TypeError('Log snapshot maximumBytes must be a positive safe integer');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Log snapshot was cancelled');
}
