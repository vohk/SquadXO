import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { ServerState } from '../../src/domain/server-state.js';
import { SquadRconClient } from '../../src/rcon/client.js';
import { ServerStateReducer } from '../../src/server/state-reducer.js';
import { SquadLogParser } from '../../src/logs/parser.js';
import { captureLines, deployableLines } from '../logs/fixtures/patch-log.js';

function legacyServer() {
  const server = new EventEmitter() as EventEmitter & {
    players: Record<string, unknown>[];
    plugins: unknown[];
    currentLayer: { layerid: string; name?: string; teams?: unknown[] };
    rcon: Record<string, unknown>;
    removeEventListener(event: string, listener: (...arguments_: unknown[]) => void): EventEmitter;
  };
  server.players = [];
  server.plugins = [];
  server.currentLayer = { layerid: 'TestLayer' };
  server.rcon = {};
  server.removeEventListener = (event, listener) => server.removeListener(event, listener);
  return server;
}

test('SocketIOAPI owns one forwarding listener per event and closes its HTTP server', async () => {
  const { default: SocketIOAPI } = await import(
    pathToFileURL(resolve('squad-server/plugins/socket-io-api.js')).href
  );
  const server = legacyServer();
  const plugin = new SocketIOAPI(
    server,
    { websocketPort: 0, securityToken: 'test-only-token' },
    {}
  );

  await plugin.mount();
  assert.equal(server.listenerCount('CHAT_MESSAGE'), 1);
  assert.ok(plugin.httpServer.listening);
  await plugin.unmount();
  assert.equal(server.listenerCount('CHAT_MESSAGE'), 0);
  assert.equal(plugin.httpServer.listening, false);
});

test('AltChecker removes Discord/server listeners and cancels delayed checks', async () => {
  const [{ default: AltChecker }, { default: DBLog }] = await Promise.all([
    import(pathToFileURL(resolve('squad-server/plugins/alt-checker.js')).href),
    import(pathToFileURL(resolve('squad-server/plugins/db-log.js')).href)
  ]);
  const server = legacyServer();
  server.rcon = { warn: async () => undefined, execute: async () => 'OK' };
  server.plugins = [Object.create(DBLog.prototype)];
  const discord = new EventEmitter() as EventEmitter & { user: { id: string } };
  discord.user = { id: 'bot' };
  const plugin = new AltChecker(
    server,
    { discordClient: 'discord', channelID: 'channel', kickIfAltDetected: false },
    { discord }
  );

  await plugin.mount();
  assert.equal(discord.listenerCount('messageCreate'), 1);
  const delayedCheck = plugin.onPlayerConnected({ ip: '127.0.0.1', player: {} });
  await plugin.unmount();
  await delayedCheck;
  assert.equal(discord.listenerCount('messageCreate'), 0);
  assert.equal(server.listenerCount('PLAYER_CONNECTED'), 0);
});

test('Discord message updaters contain command callback rejections and retain their listener', async () => {
  const { default: DiscordBaseMessageUpdater } = await import(
    pathToFileURL(resolve('squad-server/plugins/discord-base-message-updater.js')).href
  );
  class FailingUpdater extends DiscordBaseMessageUpdater {
    async generateMessage() {
      throw new Error('Discord rejected the status payload');
    }
  }
  const discord = new EventEmitter();
  const messageStore = {
    define: () => ({ sync: async () => undefined, findAll: async () => [] })
  };
  const plugin = Reflect.construct(FailingUpdater, [
    legacyServer(),
    { discordClient: 'discord', messageStore: 'sqlite', command: '!status' },
    { discord, sqlite: messageStore }
  ]) as FailingUpdater;
  const failures: unknown[][] = [];
  plugin.verbose = (...arguments_: unknown[]) => void failures.push(arguments_);

  await plugin.mount();
  discord.emit('messageCreate', {
    content: '!status',
    channel: { send: async () => undefined }
  });
  await new Promise((resolveDelay) => setImmediate(resolveDelay));

  assert.equal(failures.length, 2);
  assert.equal(failures[1]?.[1], 'Could not process Discord command:');
  assert.equal(discord.listenerCount('messageCreate'), 1);
  assert.equal(discord.listeners('messageCreate')[0], plugin.handleDiscordMessage);
  await plugin.unmount();
  assert.equal(discord.listenerCount('messageCreate'), 0);
  await plugin.mount();
  assert.deepEqual(discord.listeners('messageCreate'), [plugin.handleDiscordMessage]);
  await plugin.unmount();
  assert.equal(discord.listenerCount('messageCreate'), 0);
});

test('TpsLogger observes public events without replacing the log parser', async () => {
  const { default: TpsLogger } = await import(
    pathToFileURL(resolve('squad-server/plugins/tps-logger.js')).href
  );
  const server = legacyServer();
  const plugin = new TpsLogger(
    server,
    {
      discordClient: 'discord',
      httpServerEnabled: true,
      httpServerPort: 0,
      tpsHistoryLength: 10
    },
    { discord: {} }
  );

  await plugin.mount();
  server.emit('TICK_RATE', { tickRate: 40, time: new Date() });
  server.emit('RAW_LOG_LINE', 'test line');
  assert.equal(plugin.tickRates.length, 1);
  assert.equal(plugin.tickRates[0].logs.count, 1);
  assert.ok(plugin.httpServerInstance.listening);
  await plugin.unmount();
  assert.equal(server.listenerCount('TICK_RATE'), 0);
  assert.equal(server.listenerCount('RAW_LOG_LINE'), 0);
  assert.equal(plugin.httpServerInstance, null);
});

test('VehicleEnteredLogger owns stable raw-line and server-information listeners', async () => {
  const [{ default: VehicleEnteredLogger }, { default: Layers }] = await Promise.all([
    import(pathToFileURL(resolve('squad-server/plugins/vehicle-entered-logger.js')).href),
    import(pathToFileURL(resolve('squad-server/layers/layers.js')).href)
  ]);
  const originalLayers = Layers.layers;
  const originalPulled = Layers.pulled;
  Layers.layers = [
    {
      layerid: 'TestLayer',
      name: 'Test Layer',
      teams: [
        { vehicles: [{ name: 'Tank', classname: 'BP_Tank_C', classNames: ['BP_Tank_C'] }] },
        { vehicles: [] }
      ]
    }
  ];
  Layers.pulled = true;
  const server = legacyServer();
  server.rcon = {
    broadcast: async () => undefined,
    warn: async () => undefined
  };
  const plugin = new VehicleEnteredLogger(
    server,
    { discordClient: 'discord', channelID: 'channel' },
    { discord: {} }
  );
  try {
    await plugin.mount();
    assert.equal(plugin.getVehicleFromAssetName('BP_Tank_C')?.name, 'Tank');
    assert.equal(server.listenerCount('RAW_LOG_LINE'), 1);
    assert.equal(server.listenerCount('UPDATED_LAYER_INFORMATION'), 1);
    await plugin.unmount();
    assert.equal(server.listenerCount('RAW_LOG_LINE'), 0);
    assert.equal(server.listenerCount('UPDATED_LAYER_INFORMATION'), 0);
  } finally {
    Layers.layers = originalLayers;
    Layers.pulled = originalPulled;
  }
});

test('timer-based legacy plugins cancel delayed and polling work on unmount', async () => {
  const [
    { default: SeedingMode },
    { default: FogOfWar },
    { default: SquadCreationBlocker },
    { default: SquadBaiting }
  ] = await Promise.all([
    import(pathToFileURL(resolve('squad-server/plugins/seeding-mode.js')).href),
    import(pathToFileURL(resolve('squad-server/plugins/fog-of-war.js')).href),
    import(pathToFileURL(resolve('squad-server/plugins/squad-creation-blocker.js')).href),
    import(pathToFileURL(resolve('squad-server/plugins/squad-baiting.js')).href)
  ]);
  const server = legacyServer();
  server.rcon = {
    broadcast: async () => undefined,
    warn: async () => undefined,
    execute: async () => 'OK',
    setFogOfWar: async () => undefined,
    getSquads: async () => []
  };
  Object.assign(server, {
    a2sPlayerCount: 0,
    getAdminsWithPermission: async () => []
  });
  const seeding = new SeedingMode(
    server,
    { interval: 60_000, waitOnNewGames: true, waitTimeOnNewGame: 60 },
    {}
  );
  const fog = new FogOfWar(server, { delay: 60_000, mode: 1 }, {});
  const blocker = new SquadCreationBlocker(server, { blockDuration: 60, broadcastMode: true }, {});
  const baiting = new SquadBaiting(
    server,
    { discordClient: 'discord', channelID: 'channel' },
    { discord: {} }
  );

  await seeding.mount();
  await fog.mount();
  await blocker.mount();
  await baiting.mount();
  seeding.onNewGame();
  await fog.onNewGame();
  blocker.handleNewGame();
  await seeding.unmount();
  await fog.unmount();
  await blocker.unmount();
  await baiting.unmount();

  assert.equal(seeding.waitTimeout, null);
  assert.equal(fog.timeouts.size, 0);
  assert.equal(blocker.unlockTimeout, null);
  assert.equal(blocker.broadcastTimeouts.length, 0);
  assert.equal(baiting.pollInterval, null);
  assert.equal(server.listenerCount('NEW_GAME'), 0);
});

test('PteroMonitor waits for an active database write before unmount completes', async (context) => {
  const { default: PteroMonitor } = await import(
    pathToFileURL(resolve('squad-server/plugins/ptero-monitor.js')).href
  );
  const server = legacyServer();
  Object.assign(server, { id: 6 });
  let releaseCreate!: () => void;
  let createStarted = false;
  const createFinished = new Promise<void>((resolveCreate) => {
    releaseCreate = resolveCreate;
  });
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'running', process: { memory_used: 1, cpu_used: 2, disk_used: 3 } })
  );
  const plugin = new PteroMonitor(
    server,
    {
      apiPrefix: 'https://panel.invalid',
      serverUUID: 'test-server',
      apiToken: 'test-token',
      updateInterval: 60,
      fetchTimeout: 8
    },
    {}
  );
  plugin.DBLogPlugin = { options: {}, match: null };
  plugin.models.ServerUsage = {
    create: async () => {
      createStarted = true;
      await createFinished;
    }
  };

  const poll = plugin.newProcInfo();
  while (!createStarted) await new Promise((resolveDelay) => setImmediate(resolveDelay));
  let unmounted = false;
  const unmount = plugin.unmount().then(() => {
    unmounted = true;
  });
  await new Promise((resolveDelay) => setImmediate(resolveDelay));
  assert.equal(unmounted, false);

  releaseCreate();
  await Promise.all([poll, unmount]);
  assert.equal(plugin.updateInFlight, null);
  assert.equal(plugin.abortController, null);
});

test('DiscordRcon uses public role membership, preserves command permissions, and removes the exact listener', async () => {
  const { default: DiscordRcon } = await import(
    pathToFileURL(resolve('squad-server/plugins/discord-rcon.js')).href
  );
  const discord = new EventEmitter();
  const commands: string[] = [];
  const server = legacyServer();
  server.rcon = {
    execute: async (command: string) => {
      commands.push(command);
      return 'OK';
    }
  };
  const plugin = new DiscordRcon(
    server,
    { discordClient: 'discord', channelID: 'console', permissions: { admin: ['AdminBroadcast'] } },
    { discord }
  );
  const replies: string[] = [];
  const message = {
    author: { bot: false },
    channel: { id: 'console', send: async () => undefined },
    content: 'AdminBroadcast hello',
    member: { roles: { cache: new Map([['admin', {}]]) } },
    reply: async (text: string) => {
      replies.push(text);
    }
  };
  await plugin.mount();
  assert.deepEqual(discord.listeners('messageCreate'), [plugin.onMessage]);
  await plugin.onMessage(message);
  await plugin.onMessage({ ...message, content: 'AdminKick target' });
  await plugin.onMessage({ ...message, member: undefined });
  await plugin.onMessage({ ...message, channel: { ...message.channel, id: 'other' } });
  await plugin.onMessage({ ...message, author: { bot: true } });
  assert.deepEqual(commands, ['AdminBroadcast hello']);
  assert.equal(replies.length, 2);
  await plugin.unmount();
  assert.equal(discord.listenerCount('messageCreate'), 0);
  await plugin.mount();
  assert.deepEqual(discord.listeners('messageCreate'), [plugin.onMessage]);
  await plugin.unmount();
  assert.equal(discord.listenerCount('messageCreate'), 0);
});

test('DiscordPlaceholder remounts without retaining old callbacks', async () => {
  const { default: DiscordPlaceholder } = await import(
    pathToFileURL(resolve('squad-server/plugins/discord-placeholder.js')).href
  );
  const discord = new EventEmitter();
  const plugin = new DiscordPlaceholder(
    legacyServer(),
    { discordClient: 'discord', channelID: 'placeholders' },
    { discord }
  );
  for (let index = 0; index < 2; index++) {
    await plugin.mount();
    assert.deepEqual(discord.listeners('messageCreate'), [plugin.onMessage]);
    await plugin.unmount();
    assert.equal(discord.listenerCount('messageCreate'), 0);
  }
});

test('SocketIOAPI forwards actual translated deployable/capture payloads and owns their teardown', async () => {
  const { default: SocketIOAPI } = await import(
    pathToFileURL(resolve('squad-server/plugins/socket-io-api.js')).href
  );
  const state = new ServerState();
  const rcon = new SquadRconClient({
    host: '127.0.0.1',
    port: 1,
    password: 'unused',
    autoReconnect: false
  });
  const host = new LegacyServerHost({ state, rcon });
  const facade = host.createFacade('socket-fixture');
  const plugin = new SocketIOAPI(facade, { websocketPort: 0, securityToken: 'fixture-token' }, {});
  const broadcasts: { name: string; data: Record<string, unknown> }[] = [];
  plugin.io.emit = (name: string, data: Record<string, unknown>) => {
    broadcasts.push({ name, data });
    return true;
  };
  const parser = new SquadLogParser();
  const reducer = new ServerStateReducer(state);
  try {
    await plugin.mount();
    for (const line of [...deployableLines, ...captureLines]) {
      for (const event of parser.parseLine(line))
        for (const reduced of reducer.reduce(event)) host.publish(reduced);
    }
    await host.drain();
    assert.equal(broadcasts.length, 8);
    const spawned = broadcasts.filter((item) => item.name === 'DEPLOYABLE_SPAWNED');
    assert.equal(spawned.length, 3);
    assert.equal(spawned[2]?.data.teamID, 0);
    assert.deepEqual(spawned[0]?.data.location, { x: 15160, y: -2150, z: -12980 });
    const neutralized = broadcasts.filter((item) => item.name === 'CAPTURE_ZONE_NEUTRALIZED');
    assert.equal(neutralized[0]?.data.previousTeamID, 1);
    assert.equal(neutralized[0]?.data.teamID, 2);
    assert.equal(neutralized[0]?.data.zoneName, 'Walled Courts');
    assert.ok(neutralized[0]?.data.time instanceof Date);
    const payload = broadcasts[0]!.data;
    await plugin.unmount();
    host.emit('DEPLOYABLE_SPAWNED', payload);
    await host.drain();
    assert.equal(broadcasts.length, 8);
    assert.equal(plugin.httpServer.listening, false);
  } finally {
    await plugin.unmount();
    facade.dispose();
  }
});
