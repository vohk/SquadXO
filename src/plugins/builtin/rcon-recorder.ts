import { createHash } from 'node:crypto';
import type { RconCommandCompletedEvent } from '../../domain/events.js';
import {
  definePlugin,
  type Plugin,
  type PluginContext,
  type ResolvedNativeOptions
} from '../api.js';
import { RecorderStore } from './rcon-recorder-store.js';

// Inspired by lbzepoqo/SquadJS RconRecorder, server 0f686f8300270a8eb50b726d476a7c28771cd938.
// Original SquadJS copyright (c) 2021 Thomas Smyth; Boost Software License 1.0 (LICENSE).
// Storage and shared-client observation are native implementations, without monkeypatching.
const options = {
  directory: {
    type: 'string',
    default: './rcon-recordings',
    description:
      'Dedicated recording directory, resolved from process working directory; use a separate directory per process/instance.'
  },
  recordLogLines: {
    type: 'boolean',
    default: false,
    description:
      'Include raw game-log lines; may contain player identities, IPs and chat. Disabled by default.'
  },
  retentionDays: {
    type: 'number',
    default: 14,
    description: 'Delete closed recordings older than this many days.'
  },
  maxTotalMB: {
    type: 'number',
    default: 1024,
    description:
      'Hard byte budget in MiB for recorder-owned active, archived and compression scratch files.'
  },
  maxFileMB: {
    type: 'number',
    default: 16,
    description: 'Rotate at this many MiB or a UTC hour change; must not exceed maxTotalMB.'
  },
  maxBufferMB: {
    type: 'number',
    default: 4,
    description: 'Maximum queued serialized MiB; excess entries are dropped without delaying RCON.'
  },
  maxEntryKB: {
    type: 'number',
    default: 64,
    description: 'Maximum serialized KiB per entry (at least 1); long text is truncated and marked.'
  },
  maxDedupEntries: {
    type: 'number',
    default: 1024,
    description:
      'Maximum cached command/response fingerprints for same-response deduplication per file.'
  },
  compress: {
    type: 'boolean',
    default: true,
    description:
      'Gzip closed files when source plus scratch fits the total budget; otherwise retain JSONL.'
  }
} as const;

type Options = ResolvedNativeOptions<typeof options>;

export class RconRecorder implements Plugin<Options> {
  #store: RecorderStore | undefined;
  #context: PluginContext<Options> | undefined;
  #reportedDrops = 0;
  #reportedIO = 0;
  #loggedIO = false;
  #cancelMaintenance: (() => void) | undefined;
  readonly #unsubscribers: (() => void)[] = [];

  async mount(context: PluginContext<Options>): Promise<void> {
    this.#context = context;
    this.#reportedDrops = 0;
    this.#reportedIO = 0;
    this.#loggedIO = false;
    const store = new RecorderStore(
      context.options,
      (error) => {
        if (this.#loggedIO) return;
        this.#loggedIO = true;
        context.logger.error('Recording I/O failed; entry dropped and later entries will retry', {
          error: error instanceof Error ? error.message : String(error)
        });
      },
      () => new Date(),
      (task) => context.track(task)
    );
    this.#store = store;
    await store.start();
    this.#unsubscribers.push(context.on('RCON_COMMAND_COMPLETED', (event) => this.#command(event)));
    this.#unsubscribers.push(
      context.on('RCON_PUSH', (event) =>
        this.#record({ type: 'push', body: event.body }, event.time)
      )
    );
    if (context.options.recordLogLines) {
      this.#unsubscribers.push(
        context.on('RCON_AUDIT_LOG_LINE', (line) => this.#record({ type: 'log', line }, new Date()))
      );
    }
    this.#cancelMaintenance = context.setInterval(async () => {
      await store.maintain();
      this.#reportDrops();
    }, 60_000);
    context.logger.info('RCON recording started', {
      directory: store.directory,
      recordLogLines: context.options.recordLogLines
    });
  }

  async unmount(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#cancelMaintenance?.();
    this.#cancelMaintenance = undefined;
    try {
      await this.#store?.stop();
    } finally {
      this.#reportDrops();
      if (this.#store) this.#context?.logger.info('RCON recording stopped', this.#store.stats);
      this.#store = undefined;
      this.#context = undefined;
    }
  }

  #command(event: RconCommandCompletedEvent): void {
    const keys =
      event.outcome === 'success' && event.response !== undefined
        ? { command: fingerprint(event.command), response: fingerprint(event.response) }
        : undefined;
    this.#record(
      {
        type: 'command',
        requestID: event.requestID,
        command: event.command,
        commandKey: keys?.command,
        requestedAt: event.requestedAt.toISOString(),
        ...(event.sentAt ? { sentAt: event.sentAt.toISOString() } : {}),
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...(event.response !== undefined ? { response: event.response } : {}),
        ...(event.error ? { errorName: event.error.name, error: event.error.message } : {})
      },
      event.time,
      keys
    );
  }

  #record(
    record: Record<string, unknown>,
    time: Date,
    keys?: { command: string; response: string }
  ): void {
    const context = this.#context;
    if (!context || context.signal.aborted) return;
    // Bound each field before encoding; only reduce it further when the complete JSON exceeds the cap.
    let budget = context.options.maxEntryKB * 1024;
    const truncated = new Set<string>();
    const content = Object.entries(record).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        !['requestedAt', 'sentAt', 'commandKey', 'type', 'outcome'].includes(key)
    );
    let bounded: Record<string, unknown>;
    do {
      for (const [key, value] of content) {
        const result = truncate(value as string, budget);
        record[key] = result.text;
        if (result.truncated) truncated.add(key);
      }
      bounded = {
        schemaVersion: 1,
        serverID: context.server.id,
        time: time.toISOString(),
        ...record,
        ...(truncated.size ? { truncated: [...truncated] } : {})
      };
      if (
        Buffer.byteLength(JSON.stringify(bounded)) + 1 <= context.options.maxEntryKB * 1024 ||
        budget <= 1
      )
        break;
      budget = Math.max(1, Math.floor(budget / 2));
    } while (budget >= 1);
    const accepted = this.#store?.enqueue(bounded, time, keys);
    if (!accepted && this.#reportedDrops === 0) this.#reportDrops();
  }

  #reportDrops(): void {
    const stats = this.#store?.stats;
    if (stats && (stats.dropped > this.#reportedDrops || stats.ioErrors > this.#reportedIO)) {
      this.#context?.logger.warn('RCON recording loss summary', {
        ...stats,
        sinceLastReport: stats.dropped - this.#reportedDrops,
        ioErrorsSinceLastReport: stats.ioErrors - this.#reportedIO
      });
      this.#reportedDrops = stats.dropped;
      this.#reportedIO = stats.ioErrors;
    }
  }
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function truncate(text: string, maximumBytes: number): { text: string; truncated: boolean } {
  const prefix = text.slice(0, maximumBytes);
  const bytes = Buffer.from(prefix);
  if (prefix.length === text.length && bytes.length <= maximumBytes)
    return { text, truncated: false };
  return {
    text: bytes
      .subarray(0, maximumBytes)
      .toString('utf8')
      .replace(/\uFFFD$/, ''),
    truncated: true
  };
}

export default definePlugin({
  apiVersion: 1,
  name: 'rconRecorder',
  description:
    'Archives shared-client RCON command outcomes and pushed bodies as bounded JSONL/gzip files, without extra commands or authentication packets.',
  options,
  connectors: {},
  create: () => new RconRecorder()
});
