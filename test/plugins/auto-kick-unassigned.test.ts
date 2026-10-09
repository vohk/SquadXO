import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { asEOSID, type EOSID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import { SquadRconClient } from '../../src/rcon/client.js';
import type { RconPlayer } from '../../src/rcon/squad-protocol.js';

class FakeRcon extends SquadRconClient {
  players: RconPlayer[] = [];
  readonly warnings: { readonly eosID: EOSID; readonly message: string }[] = [];
  readonly kicks: { readonly eosID: EOSID; readonly reason: string }[] = [];

  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }

  override async listPlayers(): Promise<RconPlayer[]> {
    return this.players.map((player) => ({ ...player }));
  }

  override async warn(eosID: EOSID, message: string): Promise<void> {
    this.warnings.push({ eosID, message });
  }

  override async kick(eosID: EOSID, reason: string): Promise<void> {
    this.kicks.push({ eosID, reason });
  }
}

interface LegacyAutoKickPlugin {
  gracePeriodTimeout: NodeJS.Timeout | null;
  trackedPlayers: Record<string, unknown>;
  mount(): Promise<void>;
  unmount(): Promise<void>;
  onNewGame(): Promise<void>;
  onPlayerSquadChange(info: unknown): Promise<void>;
  updateTrackingList(forceUpdate?: boolean): Promise<void>;
  clearDisconnectedPlayers(): Promise<void>;
}

const eosID = asEOSID('11111111111111111111111111111111');

function rconPlayer(squadID: number | null, teamID: number | null = 1): RconPlayer {
  return {
    playerID: 1,
    eosID,
    name: 'Unassigned',
    teamID,
    squadID,
    isLeader: false,
    role: 'Rifleman'
  };
}

async function loadPlugin(): Promise<{
  new (
    server: unknown,
    options: Record<string, unknown>,
    connectors: Record<string, unknown>
  ): LegacyAutoKickPlugin;
}> {
  const imported = (await import(
    pathToFileURL(resolve('squad-server/plugins/auto-kick-unassigned.js')).href
  )) as { default: unknown };
  return imported.default as {
    new (
      server: unknown,
      options: Record<string, unknown>,
      connectors: Record<string, unknown>
    ): LegacyAutoKickPlugin;
  };
}

test('AutoKickUnassigned releases grace and player timers on unmount', async () => {
  const AutoKickUnassigned = await loadPlugin();
  const state = new ServerState();
  const host = new LegacyServerHost({ state, rcon: new FakeRcon() });
  const facade = host.createFacade('AutoKickUnassigned');
  const plugin = new AutoKickUnassigned(
    facade,
    {
      playerThreshold: -1,
      roundStartDelay: 900,
      unassignedTimer: 360,
      frequencyOfWarnings: 30
    },
    {}
  );

  try {
    await plugin.mount();
    await plugin.onNewGame();
    const firstGraceTimer = plugin.gracePeriodTimeout;
    assert.ok(firstGraceTimer);
    await plugin.onNewGame();
    assert.notEqual(plugin.gracePeriodTimeout, firstGraceTimer);
    plugin.trackedPlayers.test = {
      player: { name: 'Unassigned' },
      warnTimerID: setInterval(() => undefined, 60_000),
      kickTimerID: setTimeout(() => undefined, 60_000)
    };
  } finally {
    await plugin.unmount();
    facade.dispose();
  }

  assert.equal(plugin.gracePeriodTimeout, null);
  assert.deepEqual(plugin.trackedPlayers, {});
});

test('AutoKickUnassigned tracks legacy null squads and handles squad-change payloads', async () => {
  const AutoKickUnassigned = await loadPlugin();
  const state = new ServerState();
  state.replacePlayers([rconPlayer(null, null)]);
  const rcon = new FakeRcon();
  const host = new LegacyServerHost({ state, rcon });
  const facade = host.createFacade('AutoKickUnassigned');
  const plugin = new AutoKickUnassigned(
    facade,
    {
      playerThreshold: 0,
      roundStartDelay: 900,
      unassignedTimer: 360,
      frequencyOfWarnings: 30
    },
    {}
  );

  try {
    assert.equal(facade.players[0]?.squadID, null);
    assert.equal(facade.players[0]?.teamID, null);
    await plugin.updateTrackingList();
    assert.ok(eosID in plugin.trackedPlayers);

    await plugin.clearDisconnectedPlayers();
    assert.ok(eosID in plugin.trackedPlayers);

    state.replacePlayers([rconPlayer(2)]);
    await plugin.onPlayerSquadChange({ player: facade.players[0], oldSquadID: null });
    assert.ok(!(eosID in plugin.trackedPlayers));

    state.replacePlayers([rconPlayer(null)]);
    await plugin.updateTrackingList();
    state.replacePlayers([]);
    await plugin.clearDisconnectedPlayers();
    assert.ok(!(eosID in plugin.trackedPlayers));
  } finally {
    await plugin.unmount();
    facade.dispose();
  }
});

test('AutoKickUnassigned warns and kicks an unassigned player after the configured delay', async () => {
  const AutoKickUnassigned = await loadPlugin();
  const state = new ServerState();
  const player = rconPlayer(null);
  state.replacePlayers([player]);
  const rcon = new FakeRcon();
  rcon.players = [player];
  const host = new LegacyServerHost({ state, rcon });
  const facade = host.createFacade('AutoKickUnassigned');
  const kicked: unknown[] = [];
  facade.on('PLAYER_AUTO_KICKED', (event) => kicked.push(event));
  const plugin = new AutoKickUnassigned(
    facade,
    {
      playerThreshold: 0,
      roundStartDelay: 0.01,
      unassignedTimer: 0.06,
      frequencyOfWarnings: 0.02
    },
    {}
  );

  try {
    await plugin.onNewGame();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(eosID in plugin.trackedPlayers);
    assert.ok(rcon.warnings.length >= 1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(rcon.kicks, [{ eosID, reason: 'Unassigned - automatically removed' }]);
    assert.equal(kicked.length, 1);
    assert.ok(!(eosID in plugin.trackedPlayers));
  } finally {
    await plugin.unmount();
    facade.dispose();
  }
});
