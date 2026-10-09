import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { rm, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Writable } from 'node:stream';
import SftpClient from 'ssh2-sftp-client';
import type {
  LogLineHandler,
  LogReader,
  LogReaderHealth,
  LogSnapshot,
  LogSnapshotOptions
} from './reader.js';
import { SftpTail } from './sftp-tail.js';

interface SnapshotSftpClient {
  connect(configuration: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password?: string;
    readonly privateKey?: string | Buffer;
  }): Promise<unknown>;
  stat(path: string): Promise<{ readonly size: number; readonly modifyTime?: number }>;
  get(path: string, destination: Writable, options?: unknown): Promise<unknown>;
  end(): Promise<unknown>;
}

export interface SftpReaderOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKey?: string | Buffer;
  readonly logDir: string;
  readonly filename?: string;
  readonly pollIntervalMs?: number;
  readonly maximumTemporaryFileSize?: number;
  readonly onError?: (error: Error) => void;
  readonly snapshotClientFactory?: () => SnapshotSftpClient;
}

export class SftpLogReader implements LogReader {
  readonly #options: SftpReaderOptions;
  #tail: SftpTail | undefined;
  #running = false;
  #lastLineAt: Date | undefined;
  #offset = 0;
  #replacements = 0;

  constructor(options: SftpReaderOptions) {
    this.#options = options;
  }

  async start(handler: LogLineHandler): Promise<void> {
    if (this.#running) throw new Error('SFTP log reader is already running');
    const pollIntervalMs = this.#options.pollIntervalMs ?? 1000;
    const tail = new SftpTail({
      connection: {
        host: this.#options.host.replace(/^sftp:\/\//, ''),
        port: this.#options.port,
        username: this.#options.username,
        ...(this.#options.password ? { password: this.#options.password } : {}),
        ...(this.#options.privateKey ? { privateKey: this.#options.privateKey } : {})
      },
      fetchInterval: pollIntervalMs,
      maximumReadSize: this.#options.maximumTemporaryFileSize ?? 5_000_000
    });
    tail.setLineHandler(async (line) => {
      try {
        await handler(line);
        this.#offset = tail.offset;
        this.#lastLineAt = new Date();
      } catch (error) {
        this.#reportError(error);
      }
    });
    tail.on('error', (error: unknown) => this.#reportError(error));
    tail.on('replacement', () => {
      this.#replacements += 1;
    });
    this.#tail = tail;
    this.#running = true;
    try {
      await tail.watch(posix.join(this.#options.logDir, this.#options.filename ?? 'SquadGame.log'));
    } catch (error) {
      this.#running = false;
      this.#tail = undefined;
      await tail.unwatch().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    const errors: unknown[] = [];
    try {
      await this.#tail?.unwatch();
    } catch (error) {
      errors.push(error);
    }
    this.#tail = undefined;
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to stop SFTP log reader');
  }

  health(): LogReaderHealth {
    return {
      running: this.#running,
      source: `sftp://${this.#options.host.replace(/^sftp:\/\//, '')}${posix.join(
        this.#options.logDir,
        this.#options.filename ?? 'SquadGame.log'
      )}`,
      offset: this.#offset,
      ...(this.#lastLineAt ? { lastLineAt: this.#lastLineAt } : {}),
      pollingLatencyMs: this.#options.pollIntervalMs ?? 1000,
      replacements: this.#replacements
    };
  }

  async copySnapshot(destination: string, options: LogSnapshotOptions): Promise<LogSnapshot> {
    validateSnapshotOptions(options);
    throwIfAborted(options.signal);
    const client: SnapshotSftpClient =
      this.#options.snapshotClientFactory?.() ??
      (new SftpClient() as unknown as SnapshotSftpClient);
    const remotePath = posix.join(this.#options.logDir, this.#options.filename ?? 'SquadGame.log');
    let output: Writable | undefined;
    const abort = (): void => {
      output?.destroy(abortError(options.signal));
      void client.end().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await client.connect({
        host: this.#options.host.replace(/^sftp:\/\//, ''),
        port: this.#options.port,
        username: this.#options.username,
        ...(this.#options.password ? { password: this.#options.password } : {}),
        ...(this.#options.privateKey ? { privateKey: this.#options.privateKey } : {})
      });
      throwIfAborted(options.signal);
      const metadata = await client.stat(remotePath);
      if (metadata.size > options.maximumBytes) {
        throw new Error(
          `Squad log is ${metadata.size} bytes; configured maximum is ${options.maximumBytes} bytes`
        );
      }
      if (metadata.size === 0) {
        await writeFile(destination, new Uint8Array(), { flag: 'wx' });
      } else {
        output = createWriteStream(destination, { flags: 'wx' });
        await client.get(remotePath, output, {
          readStreamOptions: { start: 0, end: metadata.size - 1 }
        });
        if (!output.writableFinished) await once(output, 'finish');
        const copied = await stat(destination);
        if (copied.size !== metadata.size) {
          throw new Error(
            `SFTP log snapshot was incomplete: expected ${metadata.size} bytes, received ${copied.size}`
          );
        }
      }
      return {
        sourceBytes: metadata.size,
        ...(metadata.modifyTime === undefined ? {} : { modifiedAt: new Date(metadata.modifyTime) })
      };
    } catch (error) {
      output?.destroy();
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      await client.end().catch(() => undefined);
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
  throw abortError(signal);
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Log snapshot was cancelled');
}
