import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import SftpClient from 'ssh2-sftp-client';

const DEFAULT_FETCH_INTERVAL = 1000;
const DEFAULT_MAX_READ_SIZE = 5_000_000;

interface RemoteTailOptions {
  readonly fetchInterval?: number;
  readonly maximumReadSize?: number;
}

type RemoteLineHandler = (line: string) => void | Promise<void>;

export interface SftpTailOptions extends RemoteTailOptions {
  readonly connection: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password?: string;
    readonly privateKey?: string | Buffer;
  };
}

export abstract class RemoteTail extends EventEmitter {
  readonly #fetchInterval: number;
  readonly #maximumReadSize: number;
  #remotePath = '';
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #pollPromise: Promise<void> | undefined;
  #decoder = new StringDecoder('utf8');
  #pendingText = '';
  #skipPartialFirstLine = false;
  #lineHandler: RemoteLineHandler | undefined;
  offset = 0;

  constructor(options: RemoteTailOptions = {}) {
    super();
    this.#fetchInterval = options.fetchInterval ?? DEFAULT_FETCH_INTERVAL;
    this.#maximumReadSize = options.maximumReadSize ?? DEFAULT_MAX_READ_SIZE;
  }

  async watch(remotePath: string): Promise<void> {
    if (this.#running) throw new Error('Remote log tail is already running');
    this.#remotePath = remotePath;
    this.#running = true;

    try {
      await this.connect();
      const size = await this.getSize(remotePath);
      this.offset = Math.max(0, size - this.#maximumReadSize);
      this.#skipPartialFirstLine = this.offset > 0;
      await this.#poll();
      this.#schedule();
    } catch (error) {
      this.#running = false;
      await this.disconnect().catch(() => undefined);
      throw error;
    }
  }

  setLineHandler(handler: RemoteLineHandler | undefined): void {
    this.#lineHandler = handler;
  }

  async unwatch(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#pollPromise;
    await this.disconnect();
    this.#decoder = new StringDecoder('utf8');
    this.#pendingText = '';
  }

  protected abstract connect(): Promise<void>;
  protected abstract disconnect(): Promise<void>;
  protected abstract getSize(remotePath: string): Promise<number>;
  protected abstract read(remotePath: string, start: number, end: number): Promise<Buffer>;

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#pollPromise = this.#poll()
        .catch(async (error: unknown) => {
          this.#reportError(error);
          try {
            await this.#reconnect();
          } catch (reconnectError) {
            this.#reportError(reconnectError);
          }
        })
        .finally(() => {
          this.#pollPromise = undefined;
          this.#schedule();
        });
    }, this.#fetchInterval);
  }

  async #poll(): Promise<void> {
    const size = await this.getSize(this.#remotePath);
    if (size < this.offset) {
      this.offset = 0;
      this.#decoder = new StringDecoder('utf8');
      this.#pendingText = '';
      this.#skipPartialFirstLine = false;
      this.emit('replacement');
    }
    if (size === this.offset) return;

    const end = Math.min(size, this.offset + this.#maximumReadSize);
    const chunk = await this.read(this.#remotePath, this.offset, end - 1);
    this.offset += chunk.length;
    await this.#consume(chunk);
  }

  async #consume(chunk: Buffer): Promise<void> {
    const text = this.#pendingText + this.#decoder.write(chunk);
    const lines = text.split('\n');
    this.#pendingText = lines.pop() ?? '';

    for (let line of lines) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (this.#skipPartialFirstLine) {
        this.#skipPartialFirstLine = false;
        continue;
      }
      if (this.#lineHandler) {
        await this.#lineHandler(line);
      } else {
        this.emit('line', line);
      }
    }
  }

  #reportError(error: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  async #reconnect(): Promise<void> {
    await this.disconnect().catch(() => undefined);
    await this.connect();
  }
}

export class SftpTail extends RemoteTail {
  readonly #connection: SftpTailOptions['connection'];
  #client = new SftpClient();
  #connected = false;

  constructor(options: SftpTailOptions) {
    super(options);
    this.#connection = options.connection;
  }

  protected async connect(): Promise<void> {
    if (this.#connected) return;
    this.#client = new SftpClient();
    await this.#client.connect(this.#connection);
    this.#connected = true;
  }

  protected async disconnect(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    await this.#client.end();
  }

  protected async getSize(remotePath: string): Promise<number> {
    const stats = await this.#client.stat(remotePath);
    return stats.size;
  }

  protected async read(remotePath: string, start: number, end: number): Promise<Buffer> {
    const result = await this.#client.get(remotePath, undefined, {
      readStreamOptions: { start, end }
    });
    if (!Buffer.isBuffer(result)) throw new Error('SFTP client returned an unexpected result');
    return result;
  }
}
