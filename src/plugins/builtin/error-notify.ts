import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gzip as gzipCallback } from 'node:zlib';
import type { APIEmbed, APIEmbedField, Client, SendableChannels } from 'discord.js';
import { definePlugin, type PluginContext } from '../api.js';

const gzip = promisify(gzipCallback);

/** Discord's baseline upload limit for guilds without server boosts. */
const DEFAULT_MAXIMUM_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PARTIAL_ATTEMPTS = 8;
const ALERT_COLOR = 0xd73a49;

const options = {
  channelID: {
    type: 'string',
    required: true,
    description: 'Discord channel that receives match notifications.'
  },
  patterns: {
    type: 'string[]',
    required: true,
    description: 'Strings that trigger a notification when they appear in a Squad log line.'
  },
  mentionRoleIDs: {
    type: 'string[]',
    default: [],
    description: 'Discord roles mentioned on each notification.'
  },
  caseSensitive: {
    type: 'boolean',
    default: false,
    description: 'Match patterns with exact letter case.'
  },
  cooldownSeconds: {
    type: 'number',
    default: 300,
    description: 'Minimum interval between notifications for the same pattern; repeats are counted.'
  },
  attachLog: {
    type: 'boolean',
    default: true,
    description: 'Attach a compressed copy of the current SquadGame.log to each notification.'
  },
  maximumAttachmentBytes: {
    type: 'number',
    default: DEFAULT_MAXIMUM_ATTACHMENT_BYTES,
    description:
      'Largest compressed attachment Discord accepts for the channel; larger logs are trimmed.'
  },
  maximumSourceBytes: {
    type: 'number',
    default: 2_147_483_648,
    description: 'Maximum uncompressed SquadGame.log size copied for one notification.'
  }
} as const;

const connectors = {
  discord: {
    type: 'discord',
    description: 'Discord bot used to deliver notifications.'
  }
} as const;

type ErrorNotifyOptions = {
  readonly channelID: string;
  readonly patterns: readonly string[];
  readonly mentionRoleIDs: readonly string[];
  readonly caseSensitive: boolean;
  readonly cooldownSeconds: number;
  readonly attachLog: boolean;
  readonly maximumAttachmentBytes: number;
  readonly maximumSourceBytes: number;
};

type ErrorNotifyContext = PluginContext<ErrorNotifyOptions, typeof connectors>;

interface PatternMatch {
  readonly pattern: string;
  readonly line: string;
  readonly detectedAt: Date;
  readonly loggedAt?: Date;
  readonly suppressed: number;
}

type LogAttachment =
  | {
      readonly status: 'complete';
      readonly name: string;
      readonly path: string;
      readonly sourceBytes: number;
      readonly compressedBytes: number;
    }
  | {
      readonly status: 'partial';
      readonly name: string;
      readonly attachment: Buffer;
      readonly sourceBytes: number;
      readonly includedBytes: number;
      readonly completeCompressedBytes: number;
      readonly compressedBytes: number;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export default definePlugin({
  apiVersion: 1,
  name: 'errorNotify',
  description:
    'Reports matching server-log text to Discord, with optional bounded log attachments.',
  options,
  connectors,
  create() {
    return {
      async mount(context) {
        validateOptions(context.options);
        const discord = context.connector('discord');
        const channel = await fetchChannel(discord, context.options.channelID);
        const matcher = createMatcher(context.options);
        const lastAlertAt = new Map<string, number>();
        const suppressed = new Map<string, number>();
        let delivery = Promise.resolve();

        context.on('RAW_LOG_LINE', (line) => {
          const pattern = matcher(line);
          if (pattern === undefined) return;
          const now = Date.now();
          const previous = lastAlertAt.get(pattern);
          if (previous !== undefined && now - previous < context.options.cooldownSeconds * 1000) {
            suppressed.set(pattern, (suppressed.get(pattern) ?? 0) + 1);
            return;
          }
          lastAlertAt.set(pattern, now);
          const loggedAt = parseLogTimestamp(line);
          const match: PatternMatch = {
            pattern,
            line,
            detectedAt: new Date(now),
            ...(loggedAt ? { loggedAt } : {}),
            suppressed: suppressed.get(pattern) ?? 0
          };
          suppressed.delete(pattern);
          delivery = delivery.catch(() => undefined).then(() => notify(context, channel, match));
          context.track(delivery);
        });

        context.logger.info('Mounted', {
          event: 'error_notify_mounted',
          channelID: context.options.channelID,
          patterns: context.options.patterns.length,
          attachLog: context.options.attachLog
        });
      }
    };
  }
});

function validateOptions(options: ErrorNotifyOptions): void {
  if (!/^\d{15,22}$/.test(options.channelID)) {
    throw new Error('channelID must be a Discord channel ID');
  }
  if (options.patterns.length === 0) throw new Error('patterns must contain at least one string');
  if (options.patterns.some((pattern) => typeof pattern !== 'string' || pattern.length === 0)) {
    throw new Error('patterns must contain only non-empty strings');
  }
  if (options.mentionRoleIDs.some((roleID) => !/^\d{15,22}$/.test(roleID))) {
    throw new Error('mentionRoleIDs must contain only Discord role IDs');
  }
  if (!Number.isFinite(options.cooldownSeconds) || options.cooldownSeconds < 0) {
    throw new Error('cooldownSeconds must be non-negative');
  }
  for (const name of ['maximumAttachmentBytes', 'maximumSourceBytes'] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
}

async function fetchChannel(discord: Client, channelID: string): Promise<SendableChannels> {
  const channel = await discord.channels.fetch(channelID);
  if (!channel?.isSendable()) throw new Error('channelID must identify a sendable Discord channel');
  return channel;
}

/** Returns the first configured pattern contained in the line. Runs synchronously per raw line. */
function createMatcher(options: ErrorNotifyOptions): (line: string) => string | undefined {
  if (options.caseSensitive) {
    return (line) => options.patterns.find((pattern) => line.includes(pattern));
  }
  const folded = options.patterns.map((pattern) => pattern.toLowerCase());
  return (line) => {
    const haystack = line.toLowerCase();
    const index = folded.findIndex((pattern) => haystack.includes(pattern));
    return index === -1 ? undefined : options.patterns[index];
  };
}

function parseLogTimestamp(line: string): Date | undefined {
  const parsed = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/.exec(line);
  if (!parsed) return undefined;
  const [year, month, day, hour, minute, second, millisecond] = parsed
    .slice(1)
    .map((value) => Number.parseInt(value, 10));
  return new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, millisecond!));
}

async function notify(
  context: ErrorNotifyContext,
  channel: SendableChannels,
  match: PatternMatch
): Promise<void> {
  if (context.signal.aborted) return;
  const startedAt = Date.now();
  let directory: string | undefined;
  try {
    let attachment: LogAttachment | undefined;
    if (context.options.attachLog) {
      directory = await mkdtemp(join(tmpdir(), 'squadxo-error-notify-'));
      attachment = await captureLog(context, directory, match.detectedAt);
    }
    const roleIDs = context.options.mentionRoleIDs;
    const content = roleIDs.map((roleID) => `<@&${roleID}>`).join(' ') || undefined;
    await channel.send({
      ...(content ? { content } : {}),
      allowedMentions: { roles: [...roleIDs] },
      embeds: [buildEmbed(context, match, attachment)],
      files:
        attachment?.status === 'complete'
          ? [{ attachment: attachment.path, name: attachment.name }]
          : attachment?.status === 'partial'
            ? [{ attachment: attachment.attachment, name: attachment.name }]
            : []
    });
    context.logger.info('Notification delivered', {
      event: 'error_notify_alert',
      pattern: match.pattern,
      suppressed: match.suppressed,
      attachment: attachment?.status ?? 'disabled',
      ...(attachment && attachment.status !== 'unavailable'
        ? { sourceBytes: attachment.sourceBytes, compressedBytes: attachment.compressedBytes }
        : {}),
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    if (context.signal.aborted) return;
    context.logger.error('Notification failed', {
      event: 'error_notify_alert',
      outcome: 'failure',
      pattern: match.pattern,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function captureLog(
  context: ErrorNotifyContext,
  directory: string,
  detectedAt: Date
): Promise<LogAttachment> {
  try {
    const snapshotPath = join(directory, 'SquadGame.log');
    const snapshot = await context.logs.copyCurrent(snapshotPath, {
      maximumBytes: context.options.maximumSourceBytes
    });
    const sourceBytes = (await stat(snapshotPath)).size;
    const baseName = `SquadGame-${fileTimestamp(detectedAt)}`;
    const archivePath = join(directory, `${baseName}.log.gz`);
    await pipeline(
      createReadStream(snapshotPath),
      createGzip(),
      createWriteStream(archivePath, { flags: 'wx' }),
      { signal: context.signal }
    );
    const compressedBytes = (await stat(archivePath)).size;
    const limit = context.options.maximumAttachmentBytes;
    if (compressedBytes <= limit) {
      return {
        status: 'complete',
        name: `${baseName}.log.gz`,
        path: archivePath,
        sourceBytes: snapshot.sourceBytes,
        compressedBytes
      };
    }

    let tailBytes = Math.min(sourceBytes, limit);
    for (let attempt = 0; attempt < PARTIAL_ATTEMPTS && tailBytes > 0; attempt += 1) {
      const tail = await readTail(snapshotPath, sourceBytes, tailBytes);
      const attachment = await gzip(tail);
      if (attachment.byteLength <= limit) {
        return {
          status: 'partial',
          name: `${baseName}-partial.log.gz`,
          attachment,
          sourceBytes,
          includedBytes: tail.byteLength,
          completeCompressedBytes: compressedBytes,
          compressedBytes: attachment.byteLength
        };
      }
      tailBytes = Math.floor(tailBytes / 2);
    }
    return {
      status: 'unavailable',
      reason: `The compressed log is ${formatBytes(compressedBytes)} and no trimmed copy fits the ${formatBytes(
        limit
      )} attachment limit.`
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    context.logger.warn('Log capture failed', {
      event: 'error_notify_log_capture',
      outcome: 'failure',
      error: message
    });
    return {
      status: 'unavailable',
      reason: message.startsWith('Squad log is ')
        ? 'The server log exceeds the configured maximumSourceBytes limit.'
        : 'The server log could not be captured. Check the SquadXO console for details.'
    };
  }
}

/** Reads the final `bytes` of the file, trimmed forward to the first complete line. */
async function readTail(path: string, sourceBytes: number, bytes: number): Promise<Buffer> {
  const start = Math.max(0, sourceBytes - bytes);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(sourceBytes - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, start);
    const data = buffer.subarray(0, bytesRead);
    if (start === 0) return data;
    const newline = data.indexOf(0x0a);
    return newline === -1 ? data : data.subarray(newline + 1);
  } finally {
    await handle.close();
  }
}

function buildEmbed(
  context: ErrorNotifyContext,
  match: PatternMatch,
  attachment: LogAttachment | undefined
): APIEmbed {
  const fields: APIEmbedField[] = [
    { name: 'Pattern', value: codeSpan(truncate(match.pattern, 1000)), inline: true },
    {
      name: 'Logged at',
      value: match.loggedAt ? discordTimestamp(match.loggedAt) : 'Not present in log line',
      inline: true
    },
    { name: 'Detected at', value: discordTimestamp(match.detectedAt), inline: true },
    ...(match.suppressed > 0
      ? [
          {
            name: 'Suppressed repeats',
            value: `${match.suppressed} further match${match.suppressed === 1 ? '' : 'es'} within the ${context.options.cooldownSeconds}s cooldown`,
            inline: false
          }
        ]
      : []),
    { name: 'Log file', value: describeAttachment(context, attachment), inline: false }
  ];
  return {
    title: truncate(`Log pattern matched: ${match.pattern}`, 256),
    description: codeBlock(redact(match.line), 4096),
    color: ALERT_COLOR,
    fields,
    timestamp: (match.loggedAt ?? match.detectedAt).toISOString(),
    footer: {
      text: ['errorNotify', `Server ${context.server.id}`, context.server.name]
        .filter(Boolean)
        .join(' • ')
    }
  };
}

function describeAttachment(
  context: ErrorNotifyContext,
  attachment: LogAttachment | undefined
): string {
  if (!attachment) return 'Attachment disabled by `attachLog`.';
  switch (attachment.status) {
    case 'complete':
      return `✅ Complete log attached as \`${attachment.name}\` (${formatBytes(
        attachment.sourceBytes
      )} uncompressed, ${formatBytes(attachment.compressedBytes)} compressed).`;
    case 'partial':
      return (
        `⚠️ **Partial log** attached as \`${attachment.name}\`. ` +
        `The complete log is ${formatBytes(attachment.completeCompressedBytes)} compressed and exceeds the ` +
        `${formatBytes(context.options.maximumAttachmentBytes)} attachment limit, so only the final ` +
        `${formatBytes(attachment.includedBytes)} of ${formatBytes(attachment.sourceBytes)} is included. ` +
        'Retrieve the full log from the server if earlier lines are needed.'
      );
    case 'unavailable':
      return `❌ **No log attached.** ${attachment.reason}`;
  }
}

function redact(value: string): string {
  return value
    .replace(/\b(RemoteAddr|IpAddress|IP):\s*[^\s,|)]+/gi, '$1: [IP redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[IP redacted]')
    .replace(/\?PASSWORD=[^\s?]+/gi, '?PASSWORD=[redacted]');
}

function codeBlock(value: string, maximum: number): string {
  const fence = '```\n';
  const body = truncate(value.replaceAll('```', "'''"), maximum - fence.length * 2);
  return `${fence}${body}\n\`\`\``;
}

function codeSpan(value: string): string {
  return `\`${value.replaceAll('`', "'")}\``;
}

function discordTimestamp(value: Date): string {
  const seconds = Math.floor(value.getTime() / 1000);
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function fileTimestamp(value: Date): string {
  return value.toISOString().replace(/\D/g, '').slice(0, 14);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
