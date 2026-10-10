import { playersResponse, squadsResponse, partiesResponse } from './fixtures/patch-rcon.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, open, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import type { RconAuditEvent } from '../../src/domain/events.js';
import { asEOSID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import type { PluginRcon, ResolvedNativeOptions } from '../../src/plugins/api.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import recorderDefinition from '../../src/plugins/builtin/rcon-recorder.js';
import { StateRefresher } from '../../src/server/state-refresher.js';
import {
  RCON_PACKET,
  RconPacketDecoder,
  encodePacket,
  type RconPacket
} from '../../src/rcon/codec.js';
import {
  RconClient,
  SquadRconClient,
  type RconConnectionLostEvent,
  type RconReconnectedEvent
} from '../../src/rcon/client.js';

class FakeRconServer extends EventEmitter {
  readonly server: Server;
  readonly responses = new Map<string, string>();
  readonly commandCounts = new Map<string, number>();
  mode: 'normal' | 'silent' | 'drop' | 'malformed' = 'normal';
  authenticationMode: 'normal' | 'silent' = 'normal';
  connections = 0;
  #sockets = new Set<Socket>();

  constructor() {
    super();
    this.server = createServer((socket) => {
      this.connections += 1;
      this.#sockets.add(socket);
      const decoder = new RconPacketDecoder();
      socket.on('data', (chunk) => {
        for (const packet of decoder.push(chunk)) this.#onPacket(socket, packet);
      });
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => undefined);
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fake server has no TCP address');
    return address.port;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  #onPacket(socket: Socket, packet: RconPacket): void {
    if (packet.type === RCON_PACKET.auth) {
      if (this.authenticationMode === 'silent') return;
      const response = Buffer.concat([
        encodePacket(RCON_PACKET.response, RCON_PACKET.end, packet.count, ''),
        encodePacket(RCON_PACKET.authResponse, RCON_PACKET.end, packet.count, '')
      ]);
      socket.write(response.subarray(0, 9));
      socket.write(response.subarray(9));
      return;
    }
    if (packet.type !== RCON_PACKET.command || packet.id !== RCON_PACKET.mid) return;

    this.commandCounts.set(packet.body, (this.commandCounts.get(packet.body) ?? 0) + 1);
    this.emit('command', packet.body);
    if (this.mode === 'silent') return;
    if (this.mode === 'drop') {
      socket.destroy();
      return;
    }
    if (this.mode === 'malformed') {
      socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
      return;
    }

    const chat = encodePacket(RCON_PACKET.chat, RCON_PACKET.mid, 0, 'unsolicited');
    const first = encodePacket(
      RCON_PACKET.response,
      RCON_PACKET.mid,
      packet.count,
      this.responses.get(packet.body) ?? 'chunk one'
    );
    const second = encodePacket(
      RCON_PACKET.response,
      RCON_PACKET.mid,
      packet.count,
      this.responses.has(packet.body) ? '' : ' chunk two'
    );
    const end = encodePacket(RCON_PACKET.response, RCON_PACKET.end, packet.count, '');
    const combined = Buffer.concat([chat, first, second, end]);
    socket.write(combined.subarray(0, 7));
    socket.write(combined.subarray(7));
  }
}

function onceWithTimeout<T>(emitter: EventEmitter, event: string, timeoutMs = 1000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('authenticates, serializes commands, combines responses, and separates chat', async () => {
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    autoReconnect: false
  });

  try {
    await client.connect();
    assert.equal(client.state, 'ready');
    const chat = onceWithTimeout<RconPacket>(client, 'chat');
    const first = client.execute('first');
    const second = client.execute('second');
    assert.equal(await first, 'chunk one chunk two');
    assert.equal(await second, 'chunk one chunk two');
    assert.equal((await chat).body, 'unsolicited');
    assert.deepEqual([...fake.commandCounts.keys()], ['first', 'second']);
    assert.equal(client.queueDepth, 0);
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('a missing end packet times out, rejects queued work, and reconnects cleanly', async () => {
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    commandTimeoutMs: 150,
    reconnectMinimumDelayMs: 10,
    reconnectMaximumDelayMs: 10,
    reconnectJitter: 0,
    random: () => 0.5
  });

  try {
    await client.connect();
    fake.mode = 'silent';
    const active = client.execute('AdminWarn "eos" message');
    const queued = client.execute('ListPlayers');
    await assert.rejects(active, /timed out/);
    await assert.rejects(queued, /timed out/);
    fake.mode = 'normal';
    if (client.state !== 'ready') await onceWithTimeout(client, 'ready');
    assert.equal(await client.execute('after reconnect'), 'chunk one chunk two');
    assert.equal(fake.commandCounts.get('AdminWarn "eos" message'), 1);
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('connection loss rejects the active command and stop prevents reconnect', async () => {
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    reconnectMinimumDelayMs: 100,
    reconnectMaximumDelayMs: 100,
    reconnectJitter: 0
  });

  try {
    await client.connect();
    fake.mode = 'drop';
    await assert.rejects(client.execute('drop me'), /closed/);
    const connections = fake.connections;
    await client.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fake.connections, connections);
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('reports an established outage once and reports recovery after reconnecting', async () => {
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    authenticationTimeoutMs: 20,
    reconnectMinimumDelayMs: 5,
    reconnectMaximumDelayMs: 5,
    reconnectJitter: 0
  });
  const losses: RconConnectionLostEvent[] = [];
  const recoveries: RconReconnectedEvent[] = [];
  client.on('connectionLost', (event: RconConnectionLostEvent) => losses.push(event));
  client.on('reconnected', (event: RconReconnectedEvent) => recoveries.push(event));

  try {
    await client.connect();
    const recovered = onceWithTimeout<RconReconnectedEvent>(client, 'reconnected');
    fake.authenticationMode = 'silent';
    fake.mode = 'drop';
    await assert.rejects(client.execute('drop and recover'), /closed/);
    fake.mode = 'normal';
    await waitFor(() => fake.connections >= 3 && client.state === 'disconnected');
    fake.authenticationMode = 'normal';
    await recovered;

    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.willReconnect, true);
    assert.match(losses[0]?.error.message ?? '', /closed/);
    assert.equal(recoveries.length, 1);
    assert.equal((recoveries[0]?.attempts ?? 0) >= 3, true);
    assert.equal((recoveries[0]?.durationMs ?? -1) >= 0, true);
    assert.equal(await client.execute('after recovery'), 'chunk one chunk two');

    await client.stop();
    assert.equal(losses.length, 1);
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('authentication has a deadline', async () => {
  const fake = new FakeRconServer();
  fake.authenticationMode = 'silent';
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    authenticationTimeoutMs: 30,
    autoReconnect: false
  });
  let establishedConnectionLosses = 0;
  client.on('connectionLost', () => {
    establishedConnectionLosses += 1;
  });

  try {
    await assert.rejects(client.connect(), /authentication timed out/);
    assert.equal(establishedConnectionLosses, 0);
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('stop rejects every caller waiting on the same connection attempt', async () => {
  const fake = new FakeRconServer();
  fake.authenticationMode = 'silent';
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    authenticationTimeoutMs: 10_000,
    autoReconnect: false
  });

  try {
    const first = client.connect();
    const second = client.connect();
    const firstRejected = assert.rejects(first, /stopped/);
    const secondRejected = assert.rejects(second, /stopped/);
    await onceWithTimeout(client, 'state');
    await client.stop();
    await firstRejected;
    await secondRejected;
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('corrupt framing fails the command and reconnects without retaining bytes', async () => {
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    reconnectMinimumDelayMs: 10,
    reconnectMaximumDelayMs: 10,
    reconnectJitter: 0
  });

  try {
    await client.connect();
    fake.mode = 'malformed';
    await assert.rejects(client.execute('corrupt'), /Invalid RCON packet size/);
    fake.mode = 'normal';
    await onceWithTimeout(client, 'ready');
    assert.equal(await client.execute('healthy'), 'chunk one chunk two');
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('command policy blocks a command before it enters the wire queue', async () => {
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password: 'secret',
    autoReconnect: false,
    commandAllowed: (command) => command === 'ListPlayers'
  });

  try {
    await client.connect();
    await assert.rejects(client.execute('AdminKick "eos" test'), /blocked by runtime policy/);
    assert.equal(await client.execute('ListPlayers'), 'chunk one chunk two');
    assert.equal(fake.commandCounts.has('AdminKick "eos" test'), false);
  } finally {
    await client.stop();
    await fake.close();
  }
});

test('ListParties client method reads and parses populated party responses on demand', async () => {
  const fake = new FakeRconServer();
  fake.responses.set('ListParties', partiesResponse);
  const port = await fake.listen();
  const client = new SquadRconClient({
    host: '127.0.0.1',
    port,
    password: 'fixture',
    autoReconnect: false,
    commandAllowed: (command) => command === 'ListParties'
  });
  try {
    await client.connect();
    const parties = await client.listParties();
    assert.deepEqual(
      parties.map((party) => party.players.length),
      [1, 2, 2]
    );
    assert.equal(parties[1]?.partyID, 0);
    assert.equal(parties[1]?.teamID, 2);
    assert.equal(fake.commandCounts.get('ListParties'), 1);
    assert.equal(fake.commandCounts.size, 1);
  } finally {
    await client.stop();
    await fake.close();
  }
});

function recorderOptions(
  directory: string,
  overrides: Partial<ResolvedNativeOptions<typeof recorderDefinition.options>> = {}
) {
  return {
    ...Object.fromEntries(
      Object.entries(recorderDefinition.options).map(([name, option]) => [name, option.default])
    ),
    directory,
    ...overrides
  } as ResolvedNativeOptions<typeof recorderDefinition.options>;
}

async function recordingEntries(directory: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.jsonl') && !file.endsWith('.gz')) continue;
    const data = await readFile(join(directory, file));
    const text = file.endsWith('.gz') ? gunzipSync(data).toString('utf8') : data.toString('utf8');
    result.push(
      ...text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    );
  }
  return result;
}

test('audit covers completion/errors once, excludes authentication, redacts the password, and isolates faulty observers', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 10, 10, 59, 59) });
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const password = 'transport-authentication-fixture';
  const client = new RconClient({
    host: '127.0.0.1',
    port,
    password,
    autoReconnect: false,
    commandAllowed: (command) => command !== 'blocked'
  });
  const audits: RconAuditEvent[] = [];
  const removeFault = client.subscribeAudit(() => {
    throw new Error('observer fault');
  });
  const removeAudit = client.subscribeAudit((event) => audits.push(event));
  try {
    await assert.rejects(client.execute('not-ready'), /not ready/);
    await client.connect();
    assert.equal(audits.filter((event) => event.type === 'push').length, 0); // auth packets are excluded
    fake.once('command', () => context.mock.timers.tick(2000));
    assert.equal(await client.execute('across-hour'), 'chunk one chunk two');
    fake.responses.set('echo', password);
    assert.equal(await client.execute('echo'), password); // audit redaction never changes the actual response
    await assert.rejects(client.execute('blocked'), /blocked/);
    await assert.rejects(client.execute(''), /empty/);
    fake.mode = 'silent';
    const active = client.execute('active');
    const queued = client.execute('queued');
    const pending = Promise.allSettled([active, queued]);
    await client.stop();
    await pending;
    const commands = audits.filter((event) => event.type === 'command');
    assert.equal(commands.length, 7);
    assert.equal(new Set(commands.map((event) => event.requestID)).size, 7);
    assert.equal(commands.filter((event) => event.outcome === 'error').length, 5);
    const cross = commands.find((event) => event.command === 'across-hour')!;
    assert.equal(cross.requestedAt.toISOString(), '2026-10-10T10:59:59.000Z');
    assert.equal(cross.time.toISOString(), '2026-10-10T11:00:01.000Z');
    assert.equal(cross.response, 'chunk one chunk two');
    assert.ok(commands.find((event) => event.command === 'active')?.sentAt);
    assert.equal(commands.find((event) => event.command === 'queued')?.sentAt, undefined);
    assert.ok(!JSON.stringify(audits).includes(password));
    assert.equal(commands.find((event) => event.command === 'echo')?.response, '[REDACTED]');
    removeFault();
    removeAudit();
    const count = audits.length;
    await assert.rejects(client.execute('after-unsubscribe'), /not ready/);
    assert.equal(audits.length, count);
  } finally {
    removeFault();
    removeAudit();
    await client.stop();
    await fake.close();
  }
});

test('native recorder captures runtime polling, native/legacy helpers and pushes without extra queries; raw lines are opt-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-shared-recorder-'));
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new SquadRconClient({
    host: '127.0.0.1',
    port,
    password: 'transport-only-fixture',
    autoReconnect: false
  });
  const state = new ServerState();
  const events = new LegacyServerHost({ state, rcon: client });
  const failures: unknown[] = [];
  const runtime = new PluginRuntime({
    state,
    rcon: client,
    events,
    connectors: new ConnectorRegistry(),
    onFailure: (failure) => failures.push(failure)
  });
  let native!: PluginRcon;
  try {
    await runtime.mount('rconRecorder', recorderDefinition.create(), recorderOptions(directory));
    await runtime.mount('actor', {
      mount(context) {
        native = context.rcon;
      }
    });
    await client.connect();
    assert.equal(fake.commandCounts.size, 0);
    assert.deepEqual(await readdir(directory), []);
    events.emit('RAW_LOG_LINE', 'sensitive raw line excluded by default');
    const eos = asEOSID('00000000000000000000000000000001');
    fake.responses.set('ListPlayers', playersResponse.replace(/ steam: \d{17}/g, ''));
    fake.responses.set('ListSquads', squadsResponse);
    fake.responses.set(
      'ShowCurrentMap',
      'Current level is Fallujah, layer is Fallujah_RAAS_v1, factions USA INS'
    );
    fake.responses.set('ShowNextMap', 'Next level is Fallujah, layer is To be voted, factions  ');
    fake.responses.set(
      'ShowServerInfo',
      JSON.stringify({ ServerName_s: 'Fixture', PlayerCount_I: 0 })
    );
    const refresher = new StateRefresher(state, client);
    await refresher.initialize();
    await native.listPlayers();
    await native.listSquads();
    await native.showCurrentMap();
    await native.showNextMap();
    await native.showServerInfo();
    await native.warn(eos, 'native');
    await native.broadcast('native');
    await native.kick(eos, 'fixture');
    await native.ban(eos, '1d', 'fixture');
    await native.forceTeamChange(eos);
    const legacy = events.createFacade('different-legacy-plugin');
    await legacy.rcon.warn(eos, 'legacy');
    await legacy.rcon.broadcast('legacy');
    await legacy.rcon.execute('explicit-legacy');
    await runtime.unmount('rconRecorder');
    const all = await recordingEntries(directory);
    const completed = all.filter((item) => item.type === 'command');
    assert.equal(
      completed.length,
      [...fake.commandCounts.values()].reduce((sum, count) => sum + count, 0)
    );
    assert.equal(all.filter((item) => item.type === 'push').length, completed.length);
    assert.ok(completed.some((item) => item.command === `AdminWarn "${eos}" legacy`));
    assert.ok(completed.some((item) => item.command === `AdminWarn "${eos}" native`));
    assert.ok(completed.some((item) => item.command === 'ListPlayers'));
    assert.ok(completed.some((item) => item.command === 'explicit-legacy'));
    assert.ok(all.every((item) => item.schemaVersion === 1));
    assert.ok(!JSON.stringify(all).includes('sensitive raw line'));
    assert.ok(!JSON.stringify(all).includes('transport-only-fixture'));
    const size = all.length;
    await native.warn(eos, 'unmounted');
    assert.equal((await recordingEntries(directory)).length, size);
    await runtime.mount(
      'rconRecorder',
      recorderDefinition.create(),
      recorderOptions(directory, { recordLogLines: true, maxEntryKB: 1 })
    );
    events.emit('RAW_LOG_LINE', 'transport-only-fixture ' + 'Ω'.repeat(10000));
    await client.stop();
    await client.connect(); // subscription survives the connection lifecycle
    await native.broadcast('after reconnect');
    await runtime.unmount('rconRecorder');
    const remounted = await recordingEntries(directory);
    const log = remounted.find((item) => item.type === 'log')!;
    assert.deepEqual(log.truncated, ['line']);
    assert.ok(String(log.line).startsWith('[REDACTED]'));
    assert.ok(!JSON.stringify(remounted).includes('transport-only-fixture'));
    assert.ok(Buffer.byteLength(JSON.stringify(log)) + 1 <= 1024);
    assert.equal(
      remounted.filter((item) => item.command === 'AdminBroadcast after reconnect').length,
      1
    );
    assert.deepEqual(failures, []);
    legacy.dispose();
  } finally {
    await runtime.stop();
    await client.stop();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('recorder overload is observable and slow disk never delays RCON completion', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadxo-recorder-overload-'));
  const probe = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const original = prototype.writeFile;
  await probe.close();
  await unlink(join(directory, 'probe'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = false;
  context.mock.method(
    prototype,
    'writeFile',
    async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
      writing = true;
      await gate;
      return original.apply(this, args);
    }
  );
  const fake = new FakeRconServer();
  const port = await fake.listen();
  const client = new SquadRconClient({
    host: '127.0.0.1',
    port,
    password: 'fixture',
    autoReconnect: false
  });
  const state = new ServerState();
  const events = new LegacyServerHost({ state, rcon: client });
  const warnings: unknown[] = [];
  const runtime = new PluginRuntime({
    state,
    rcon: client,
    events,
    connectors: new ConnectorRegistry(),
    logger: (_plugin, level, _message, details) => {
      if (level === 'warn') warnings.push(details);
    }
  });
  try {
    await runtime.mount(
      'rconRecorder',
      recorderDefinition.create(),
      recorderOptions(directory, { maxBufferMB: 0.001, maxEntryKB: 1, compress: false })
    );
    await client.connect();
    await client.execute('first');
    await waitFor(() => writing);
    for (let index = 0; index < 20; index++)
      assert.equal(await client.execute(`fast-${index}`), 'chunk one chunk two');
    assert.equal(fake.commandCounts.size, 21); // all completed while writes are still blocked
    assert.ok(warnings.length > 0);
    release();
    await runtime.stop();
    const all = await recordingEntries(directory);
    assert.ok(all.length < 42);
  } finally {
    release();
    await runtime.stop();
    await client.stop();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});
