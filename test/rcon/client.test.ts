import { partiesResponse } from './fixtures/patch-rcon.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
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
