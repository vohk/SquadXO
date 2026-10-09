import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  LegacyPluginLoader,
  LegacyPluginStartupError
} from '../../src/compatibility/legacy-plugin-loader.js';
import {
  LegacyServerHost,
  type LegacyServerFacade
} from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { asEOSID, asSteamID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import type { Plugin } from '../../src/plugins/api.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';
import { ServerStateReducer } from '../../src/server/state-reducer.js';

const eosID = asEOSID('11111111111111111111111111111111');
const victimEOSID = asEOSID('22222222222222222222222222222222');

class FakeRcon extends SquadRconClient {
  readonly warnings: { eosID: string; message: string }[] = [];
  readonly broadcasts: string[] = [];
  readonly commands: string[] = [];

  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }

  override async warn(target: typeof eosID, message: string): Promise<void> {
    this.warnings.push({ eosID: target, message });
  }

  override async broadcast(message: string): Promise<void> {
    this.broadcasts.push(message);
  }

  override async execute(command: string): Promise<string> {
    this.commands.push(command);
    return 'OK';
  }

  override async listSquads() {
    return [
      {
        squadID: 1,
        squadName: 'Test Squad',
        size: 1,
        locked: false,
        teamID: 1,
        teamName: 'Test Team',
        creatorName: 'Alpha',
        creatorEOSID: eosID
      }
    ];
  }
}

test('mounts representative legacy event, Discord, and timer plugins and releases listeners', async () => {
  const state = new ServerState();
  const player = state.upsertPlayer({
    eosID,
    steamID: asSteamID('76561198000000001'),
    name: 'Alpha',
    teamID: 1
  });
  state.upsertPlayer({
    eosID: victimEOSID,
    steamID: asSteamID('76561198000000002'),
    name: 'Bravo',
    teamID: 1
  });
  const reducer = new ServerStateReducer(state);
  const rcon = new FakeRcon();
  const sent: unknown[] = [];
  const discord = {
    channels: {
      fetch: async () => ({ send: async (message: unknown) => void sent.push(message) })
    }
  };
  const failures: Error[] = [];
  const host = new LegacyServerHost({
    state,
    rcon,
    onPluginFailure: (failure) => failures.push(failure.error)
  });
  const loader = new LegacyPluginLoader({
    host,
    connectors: new ConnectorRegistry({ discord }),
    serverOptions: { id: 1 }
  });
  const pluginPath = (name: string): string => resolve('squad-server/plugins', name);

  await loader.load(pluginPath('chat-commands.js'), {
    commands: [{ command: 'hello', type: 'warn', response: 'Hello!', ignoreChats: [] }]
  });
  await loader.load(pluginPath('auto-tk-warn.js'), {
    attackerMessage: 'Apologise',
    victimMessage: null
  });
  host.setLegacyLayers({ name: 'Old Layer', layerid: 'Old_AAS_v1' }, undefined);
  host.recordLegacyLayer(
    { name: 'New Layer', layerid: 'New_RAAS_v1' },
    new Date('2026-08-15T12:01:00Z')
  );
  await loader.load(pluginPath('discord-round-winner.js'), {
    discordClient: 'discord',
    channelID: 'test-channel',
    color: 123
  });
  await loader.load(pluginPath('discord-teamkill.js'), {
    discordClient: 'discord',
    channelID: 'test-channel',
    color: 123,
    disableCBL: true
  });
  await loader.load(pluginPath('intervalled-broadcasts.js'), {
    broadcasts: ['One', 'Two'],
    interval: 5
  });
  assert.equal(host.plugins.length, 5);

  host.publish({
    name: 'CHAT_MESSAGE',
    data: { message: '!hello world', chat: 'ChatAll', player }
  });
  const [wound] = reducer.reduce({
    name: 'PLAYER_WOUNDED',
    data: {
      time: new Date('2026-08-15T12:00:30Z'),
      attackerEOSID: eosID,
      victimName: 'Bravo',
      weapon: 'BP_Rifle'
    }
  });
  assert.ok(wound);
  host.publish(wound);
  host.publish({
    name: 'ROUND_ENDED',
    data: { time: new Date('2026-08-15T12:00:00Z'), winner: null, loser: null }
  });
  host.publish({
    name: 'NEW_GAME',
    data: {
      time: new Date('2026-08-15T12:01:00Z'),
      winner: 'Blue Team',
      dlc: 'Game',
      mapClassname: 'NewMap',
      layerClassname: 'NewLayer'
    }
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 18));
  await host.drain();

  assert.deepEqual(rcon.warnings, [
    { eosID, message: 'Hello!' },
    { eosID, message: 'Apologise' }
  ]);
  assert.equal(sent.length, 2);
  assert.ok(
    sent.some(
      (message) =>
        (message as { embeds?: { title?: string }[] }).embeds?.[0]?.title === 'Teamkill: Alpha'
    )
  );
  assert.ok(rcon.broadcasts.length >= 2);
  assert.deepEqual(failures, []);

  await loader.stop();
  assert.equal(host.plugins.length, 0);
  const warningCount = rcon.warnings.length;
  const broadcastCount = rcon.broadcasts.length;
  host.publish({
    name: 'CHAT_MESSAGE',
    data: { message: '!hello again', chat: 'ChatAll', player }
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 12));
  assert.equal(rcon.warnings.length, warningCount);
  assert.equal(rcon.broadcasts.length, broadcastCount);
});

test('native runtime isolates callback failures and aborts plugins on shutdown', async () => {
  const state = new ServerState();
  const rcon = new FakeRcon();
  const failures: string[] = [];
  const host = new LegacyServerHost({
    state,
    rcon,
    onPluginFailure: (failure) => failures.push(`${failure.plugin}:${failure.error.message}`)
  });
  const runtime = new PluginRuntime({
    state,
    rcon,
    connectors: new ConnectorRegistry(),
    events: host
  });
  let signal: AbortSignal | undefined;
  let healthyCalls = 0;
  const failing: Plugin = {
    mount: (context) => {
      signal = context.signal;
      context.on('TICK_RATE', async () => {
        throw new Error('broken callback');
      });
    }
  };
  const healthy: Plugin = {
    mount: (context) => {
      context.on('TICK_RATE', () => {
        healthyCalls += 1;
      });
    }
  };
  await runtime.mount('failing', failing);
  await runtime.mount('healthy', healthy);

  host.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 50 } });
  await host.drain();
  assert.deepEqual(failures, ['failing:broken callback']);
  assert.equal(healthyCalls, 1);

  await runtime.stop();
  assert.equal(signal?.aborted, true);
  host.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 49 } });
  assert.equal(healthyCalls, 1);
});

test('legacy loader reports mount and cleanup failures without retaining the plugin', async () => {
  const state = new ServerState();
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const loader = new LegacyPluginLoader({ host, connectors: new ConnectorRegistry() });
  class BrokenPlugin {
    async mount(): Promise<void> {
      throw new Error('mount failed');
    }

    async unmount(): Promise<void> {
      throw new Error('cleanup failed');
    }
  }

  await assert.rejects(
    loader.mount(BrokenPlugin, {}),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (entry) =>
          entry instanceof LegacyPluginStartupError &&
          entry.plugin === 'BrokenPlugin' &&
          entry.stage === 'mount' &&
          entry.cause instanceof Error &&
          entry.cause.message === 'mount failed'
      ) &&
      error.errors.some((entry) => entry instanceof Error && entry.message === 'cleanup failed')
  );
  assert.equal(host.plugins.length, 0);
  await loader.stop();
});

test('legacy loader identifies constructor failures and disposes partial subscriptions', async () => {
  const state = new ServerState();
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const loader = new LegacyPluginLoader({ host, connectors: new ConnectorRegistry() });
  let calls = 0;
  class ConstructorFailure {
    constructor(server: LegacyServerFacade) {
      server.on('TICK_RATE', () => {
        calls += 1;
      });
      throw new Error("Cannot read properties of undefined (reading 'bind')");
    }
  }

  await assert.rejects(
    loader.mount(ConstructorFailure, {}),
    (error: unknown) =>
      error instanceof LegacyPluginStartupError &&
      error.plugin === 'ConstructorFailure' &&
      error.stage === 'constructor' &&
      error.message.includes("Cannot read properties of undefined (reading 'bind')")
  );
  host.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 50 } });
  assert.equal(calls, 0);
  assert.equal(host.plugins.length, 0);
});

test('legacy loader identifies prepare failures and runs plugin cleanup', async () => {
  const state = new ServerState();
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const loader = new LegacyPluginLoader({ host, connectors: new ConnectorRegistry() });
  let cleaned = false;
  class PrepareFailure {
    prepareToMount(): void {
      throw new Error('invalid plugin option');
    }

    unmount(): void {
      cleaned = true;
    }
  }

  await assert.rejects(
    loader.mount(PrepareFailure, {}),
    (error: unknown) =>
      error instanceof LegacyPluginStartupError &&
      error.plugin === 'PrepareFailure' &&
      error.stage === 'prepare' &&
      error.message.includes('invalid plugin option')
  );
  assert.equal(cleaned, true);
  assert.equal(host.plugins.length, 0);
});

test('legacy facade exposes stable server status fields during empty-server transitions', () => {
  const state = new ServerState();
  state.setLayers(
    { level: 'TestMap', layer: 'TestMap_RAAS_v1', team1Faction: null, team2Faction: null },
    { level: 'NextMap', layer: null, team1Faction: null, team2Faction: null }
  );
  state.setServerInfo({
    ServerName_s: 'Test Server',
    MaxPlayers: '100',
    PlayerReserveCount_I: '2',
    PlayerCount_I: '0',
    PublicQueue_I: '0',
    ReservedQueue_I: '0',
    PLAYTIME_I: '120',
    GameVersion_s: 'test-version'
  });
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const facade = host.createFacade('DiscordServerStatus', { id: 1 });

  assert.equal(facade.serverName, 'Test Server');
  assert.equal(facade.a2sPlayerCount, 0);
  assert.equal(facade.publicSlots, 98);
  assert.equal(facade.reserveSlots, 2);
  assert.equal(facade.currentLayer?.name, 'TestMap_RAAS_v1');
  assert.equal(facade.nextLayerToBeVoted, true);
  assert.equal(facade.gameVersion, 'test-version');
  assert.ok(facade.matchStartTime instanceof Date);

  state.setLayers(
    {
      level: 'JensensRange_USA-PLA',
      layer: 'JensensRange_USA-PLA',
      team1Faction: 'USA',
      team2Faction: 'PLA'
    },
    { level: null, layer: null, team1Faction: null, team2Faction: null }
  );
  assert.equal(facade.currentLayer?.name, "Jensen's Range");

  host.setLegacyLayers({ name: 'Unknown', layerid: 'JensensRange_USA-PLA', teams: [] }, undefined);
  assert.equal(facade.currentLayer?.name, "Jensen's Range");

  const roundStartedAt = new Date('2026-08-16T07:00:00Z');
  state.setServerInfo({ ServerName_s: 'Sleeping Test Server' });
  host.publish({
    name: 'NEW_GAME',
    data: {
      time: roundStartedAt,
      dlc: 'Game',
      mapClassname: 'TestMap',
      layerClassname: 'TestMap_RAAS_v1'
    }
  });
  assert.equal(facade.matchStartTime.toISOString(), roundStartedAt.toISOString());
});

test('legacy facade retains bounded layer history and enriches new-game events', () => {
  const state = new ServerState();
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const facade = host.createFacade('DiscordRoundWinner');
  const oldLayer = { name: 'Old Layer', layerid: 'Old_AAS_v1' };
  const newLayer = { name: 'New Layer', layerid: 'New_RAAS_v1' };
  host.setLegacyLayers(oldLayer, undefined);
  host.recordLegacyLayer(newLayer, new Date('2026-08-16T07:00:00Z'));
  let eventLayer: unknown;
  facade.on('NEW_GAME', (event) => {
    eventLayer = event.layer;
  });

  host.publish({
    name: 'NEW_GAME',
    data: {
      time: new Date('2026-08-16T07:00:00Z'),
      dlc: 'Game',
      mapClassname: 'NewMap',
      layerClassname: 'NewLayer'
    }
  });

  assert.equal(facade.currentLayer?.layerid, 'New_RAAS_v1');
  assert.equal(facade.layerHistory[1]?.layer.layerid, 'Old_AAS_v1');
  assert.equal((eventLayer as { layerid: string }).layerid, 'New_RAAS_v1');
});

test('legacy facade removes listeners by event and releases one-shot subscriptions', () => {
  const state = new ServerState();
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const facade = host.createFacade('ListenerCompatibility');
  const received: string[] = [];
  const shared = (data: { value: string }): void => void received.push(data.value);
  facade.on('FIRST', shared);
  facade.on('SECOND', shared);
  facade.off('FIRST', shared);
  facade.once('ONCE', shared);

  host.emit('FIRST', { value: 'first' });
  host.emit('SECOND', { value: 'second' });
  host.emit('ONCE', { value: 'once' });
  host.emit('ONCE', { value: 'twice' });

  assert.deepEqual(received, ['second', 'once']);
  facade.dispose();
  host.emit('SECOND', { value: 'after-dispose' });
  assert.deepEqual(received, ['second', 'once']);
});

test('legacy facade refreshes squads and routes fog commands through the owned RCON client', async () => {
  const state = new ServerState();
  const rcon = new FakeRcon();
  const host = new LegacyServerHost({ state, rcon });
  const facade = host.createFacade('CompatibilityPlugin');

  await facade.updateSquadList();
  await facade.rcon.setFogOfWar(2);

  assert.equal(state.snapshot().squads[0]?.squadName, 'Test Squad');
  assert.deepEqual(rcon.commands, ['AdminSetFogOfWar 2']);
});

test('legacy facade attaches squads to players and preserves admin ID remapping semantics', () => {
  const state = new ServerState();
  const steamID = asSteamID('76561198000000001');
  state.upsertPlayer({ eosID, steamID, name: 'Alpha', teamID: 1, squadID: 1 });
  state.replaceSquads([
    {
      squadID: 1,
      squadName: 'Test Squad',
      size: 1,
      locked: false,
      teamID: 1,
      teamName: 'Test Faction',
      creatorName: 'Alpha',
      creatorEOSID: eosID
    }
  ]);
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  host.replaceAdmins({ [steamID]: { canseeadminchat: true } });
  const facade = host.createFacade('CompatibilityPlugin');

  assert.equal((facade.players[0]?.squad as { teamName?: string }).teamName, 'Test Faction');
  assert.deepEqual(facade.getAdminsWithPermission('canseeadminchat', 'anyID'), [eosID]);
  assert.deepEqual(facade.getAdminsWithPermission('canseeadminchat', 'player'), [
    facade.players[0]
  ]);
  assert.throws(() => facade.getAdminsWithPermission('canseeadminchat', 'invalid'));
  assert.equal(Object.getOwnPropertyNames(facade).includes('players'), true);
  assert.equal(
    Object.getOwnPropertyNames(Object.getPrototypeOf(facade)).includes('players'),
    false
  );
});

test('SocketIOAPI reflection sees legacy state as properties rather than callable methods', async () => {
  const { default: SocketIOAPI } = await import(
    pathToFileURL(resolve('squad-server/plugins/socket-io-api.js')).href
  );
  const state = new ServerState();
  state.upsertPlayer({ eosID, name: 'Alpha' });
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const facade = host.createFacade('SocketIOAPI');
  const handlers = new Map<string, (...arguments_: unknown[]) => void>();
  const socket = {
    on(name: string, handler: (...arguments_: unknown[]) => void): void {
      handlers.set(name, handler);
    }
  };

  SocketIOAPI.prototype.bindListeners.call({ verbose: () => undefined }, socket, facade);
  let response: unknown;
  handlers.get('players')?.((value: unknown) => {
    response = value;
  });

  assert.deepEqual(response, facade.players);
});

test('legacy facade manual refreshes use shared hooks', async () => {
  const state = new ServerState();
  const calls: string[] = [];
  const host = new LegacyServerHost({
    state,
    rcon: new FakeRcon(),
    operations: {
      refreshPlayers: async () => void calls.push('players'),
      refreshSquads: async () => void calls.push('squads'),
      refreshAdmins: async () => void calls.push('admins')
    }
  });
  const facade = host.createFacade('SubsystemRestarter');

  await facade.updatePlayerList();
  await facade.updateSquadList();
  await facade.updateAdmins();
  assert.deepEqual(calls, ['players', 'squads', 'admins']);
  assert.equal('restartRCON' in facade, false);
  assert.equal('restartLogParser' in facade, false);
});

test('legacy batch mounting exposes every configured plugin before prepare and mount', async () => {
  const state = new ServerState();
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const loader = new LegacyPluginLoader({ host, connectors: new ConnectorRegistry() });
  const observations: number[] = [];
  class FirstPlugin {
    constructor(readonly server: LegacyServerFacade) {}
    prepareToMount(): void {
      observations.push(this.server.plugins.length);
    }
  }
  class SecondPlugin {
    constructor(readonly server: LegacyServerFacade) {}
    mount(): void {
      observations.push(this.server.plugins.length);
    }
  }

  await loader.mountAll([
    { PluginClass: FirstPlugin, rawOptions: {} },
    { PluginClass: SecondPlugin, rawOptions: {} }
  ]);
  assert.deepEqual(observations, [2, 2]);
  await loader.stop();
});
