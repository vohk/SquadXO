import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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
  Object.assign(discord, {
    removeEventListener: (event: string, listener: (...arguments_: unknown[]) => void) =>
      discord.removeListener(event, listener)
  });
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
