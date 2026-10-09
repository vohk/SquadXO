import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import { LocalTailReader } from '../../src/logs/local-tail-reader.js';
import errorNotify from '../../src/plugins/builtin/error-notify.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';

const channelID = '123456789012345678';
const roleID = '234567890123456789';
const prefix = '[2026.08.22-12.00.00:000][ 0]';

interface SentMessage {
  readonly content?: string;
  readonly allowedMentions?: { readonly roles: readonly string[] };
  readonly embeds: readonly {
    readonly title: string;
    readonly description: string;
    readonly timestamp: string;
    readonly footer: { readonly text: string };
    readonly fields: readonly { readonly name: string; readonly value: string }[];
  }[];
  readonly files: readonly { readonly attachment: string | Buffer; readonly name: string }[];
}

class FakeRcon extends SquadRconClient {
  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }
}

class FakeChannel {
  readonly messages: SentMessage[] = [];
  readonly uploads: Buffer[] = [];

  isSendable(): boolean {
    return true;
  }

  async send(message: SentMessage): Promise<void> {
    for (const file of message.files) {
      this.uploads.push(
        Buffer.isBuffer(file.attachment) ? file.attachment : await readFile(file.attachment)
      );
    }
    this.messages.push(message);
  }
}

const defaults = {
  channelID,
  patterns: ['LogNet: Warning: Network', 'fatal error'],
  mentionRoleIDs: [roleID],
  caseSensitive: false,
  cooldownSeconds: 300,
  attachLog: true,
  maximumAttachmentBytes: 10 * 1024 * 1024,
  maximumSourceBytes: 1024 * 1024
};

async function harness(
  t: TestContext,
  logContent: string | Buffer,
  overrides: Partial<typeof defaults> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-error-notify-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'SquadGame.log');
  await writeFile(source, logContent);
  const channel = new FakeChannel();
  const discord = {
    channels: { fetch: async (id: string) => (id === channelID ? channel : null) }
  };
  const state = new ServerState();
  const rcon = new FakeRcon();
  const events = new LegacyServerHost({ state, rcon });
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry({ discord }),
    logs: new LocalTailReader({ path: source }),
    server: { id: 1, name: 'UNN #1' }
  });
  await runtime.mount(
    'errorNotify',
    errorNotify.create(),
    { ...defaults, ...overrides },
    { discord: 'discord' }
  );
  return { runtime, events, channel };
}

test('errorNotify posts an embed, pings roles, attaches the complete log, and applies cooldown', async (t) => {
  const logContent = `${prefix}LogSquad: Server started\n${prefix}LogNet: Warning: Network connection closed\n`;
  const { runtime, events, channel } = await harness(t, logContent);

  events.emit('RAW_LOG_LINE', `${prefix}LogSquad: Ordinary line`);
  events.emit(
    'RAW_LOG_LINE',
    `${prefix}lognet: warning: network connection closed RemoteAddr: 192.0.2.1`
  );
  await waitFor(() => channel.messages.length === 1);

  const message = channel.messages[0]!;
  assert.equal(message.content, `<@&${roleID}>`);
  assert.deepEqual(message.allowedMentions, { roles: [roleID] });
  const embed = message.embeds[0]!;
  assert.equal(embed.title, 'Log pattern matched: LogNet: Warning: Network');
  assert.match(embed.description, /network connection closed/);
  assert.doesNotMatch(embed.description, /192\.0\.2\.1/);
  assert.equal(embed.timestamp, '2026-08-22T12:00:00.000Z');
  assert.equal(embed.footer.text, 'errorNotify • Server 1 • UNN #1');
  const fieldsByName = new Map(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(fieldsByName.get('Pattern'), '`LogNet: Warning: Network`');
  const loggedAtSeconds = Math.floor(Date.parse('2026-08-22T12:00:00.000Z') / 1000);
  assert.equal(
    fieldsByName.get('Logged at'),
    `<t:${loggedAtSeconds}:F> (<t:${loggedAtSeconds}:R>)`
  );
  assert.match(fieldsByName.get('Log file')!, /Complete log attached/);
  assert.equal(fieldsByName.has('Suppressed repeats'), false);
  assert.equal(message.files.length, 1);
  assert.match(message.files[0]!.name, /^SquadGame-\d{14}\.log\.gz$/);
  assert.equal(gunzipSync(channel.uploads[0]!).toString('utf8'), logContent);

  // Same pattern within the cooldown is counted rather than re-posted.
  events.emit('RAW_LOG_LINE', `${prefix}LogNet: Warning: Network again`);
  events.emit('RAW_LOG_LINE', `${prefix}LogNet: Warning: Network and again`);
  // A different pattern is still delivered immediately.
  events.emit('RAW_LOG_LINE', 'Fatal error: something broke');
  await waitFor(() => channel.messages.length === 2);
  const second = channel.messages[1]!.embeds[0]!;
  assert.equal(second.title, 'Log pattern matched: fatal error');
  const secondFields = new Map(second.fields.map((field) => [field.name, field.value]));
  assert.equal(secondFields.get('Logged at'), 'Not present in log line');

  await runtime.stop();
  events.emit('RAW_LOG_LINE', 'fatal error after shutdown');
  await new Promise((resolveDelay) => setImmediate(resolveDelay));
  assert.equal(channel.messages.length, 2);
});

test('errorNotify reports suppressed repeats once the cooldown expires', async (t) => {
  const { runtime, events, channel } = await harness(t, 'log\n', {
    cooldownSeconds: 0.05,
    attachLog: false
  });
  events.emit('RAW_LOG_LINE', 'fatal error one');
  events.emit('RAW_LOG_LINE', 'fatal error two');
  events.emit('RAW_LOG_LINE', 'fatal error three');
  await waitFor(() => channel.messages.length === 1);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
  events.emit('RAW_LOG_LINE', 'fatal error four');
  await waitFor(() => channel.messages.length === 2);

  const fields = new Map(channel.messages[1]!.embeds[0]!.fields.map((f) => [f.name, f.value]));
  assert.match(fields.get('Suppressed repeats')!, /^2 further matches/);
  assert.match(fields.get('Log file')!, /Attachment disabled/);
  assert.deepEqual(channel.messages[1]!.files, []);
  await runtime.stop();
});

test('errorNotify attaches a trimmed tail and flags it when the log exceeds the limit', async (t) => {
  // Random hex does not compress, so the gzip of the full file exceeds the limit.
  const lines = Array.from(
    { length: 64 },
    (_, index) =>
      `${prefix}LogSquad: ${index.toString().padStart(3, '0')} ${randomBytes(48).toString('hex')}`
  );
  const logContent = `${lines.join('\n')}\n`;
  const limit = 1500;
  const { runtime, events, channel } = await harness(t, logContent, {
    maximumAttachmentBytes: limit,
    mentionRoleIDs: []
  });

  events.emit('RAW_LOG_LINE', 'FATAL ERROR: engine crashed');
  await waitFor(() => channel.messages.length === 1);

  const message = channel.messages[0]!;
  assert.equal(message.content, undefined);
  const fields = new Map(message.embeds[0]!.fields.map((f) => [f.name, f.value]));
  assert.match(fields.get('Log file')!, /Partial log/);
  assert.match(fields.get('Log file')!, /exceeds the 1\.5 KiB attachment limit/);
  assert.match(message.files[0]!.name, /-partial\.log\.gz$/);
  assert.ok(channel.uploads[0]!.byteLength <= limit);
  const tail = gunzipSync(channel.uploads[0]!).toString('utf8');
  assert.ok(logContent.endsWith(tail));
  assert.ok(tail.length < logContent.length);
  assert.match(tail, /^\[2026/);
  assert.equal(tail.endsWith('\n'), true);
  await runtime.stop();
});

test('errorNotify still posts when the log cannot be captured', async (t) => {
  const { runtime, events, channel } = await harness(t, 'x'.repeat(2048), {
    maximumSourceBytes: 16
  });
  events.emit('RAW_LOG_LINE', 'fatal error');
  await waitFor(() => channel.messages.length === 1);
  const fields = new Map(channel.messages[0]!.embeds[0]!.fields.map((f) => [f.name, f.value]));
  assert.match(fields.get('Log file')!, /No log attached/);
  assert.match(fields.get('Log file')!, /maximumSourceBytes/);
  assert.deepEqual(channel.messages[0]!.files, []);
  await runtime.stop();
});

test('errorNotify rejects invalid configuration before subscribing', async (t) => {
  const cases: ReadonlyArray<[Partial<typeof defaults>, RegExp]> = [
    [{ patterns: [] }, /at least one string/],
    [{ patterns: [''] }, /non-empty strings/],
    [{ mentionRoleIDs: ['staff'] }, /Discord role IDs/],
    [{ channelID: 'general' }, /Discord channel ID/],
    [{ cooldownSeconds: -1 }, /non-negative/],
    [{ maximumAttachmentBytes: 0 }, /positive safe integer/]
  ];
  for (const [overrides, expected] of cases) {
    await assert.rejects(harness(t, 'log\n', overrides), expected);
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for errorNotify');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}
