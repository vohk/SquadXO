import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { asEOSID, asSteamID } from '../../src/domain/identity.js';
import { ServerState } from '../../src/domain/server-state.js';
import { SquadRconClient } from '../../src/rcon/client.js';
import type { RconPacket } from '../../src/rcon/codec.js';
import type { RconPlayer } from '../../src/rcon/squad-protocol.js';
import { startRconChatBridge } from '../../src/server/rcon-chat-bridge.js';
import { StateRefresher } from '../../src/server/state-refresher.js';

const eosID = asEOSID('11111111111111111111111111111111');
const steamID = asSteamID('76561198000000001');

class FakeRcon extends SquadRconClient {
  readonly commands: string[] = [];
  readonly player: RconPlayer = {
    playerID: 1,
    eosID,
    steamID,
    name: 'Alpha',
    teamID: 2,
    squadID: null,
    isLeader: false,
    role: 'Rifleman'
  };

  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }

  override async listPlayers(): Promise<RconPlayer[]> {
    return [{ ...this.player }];
  }

  override async execute(command: string): Promise<string> {
    this.commands.push(command);
    return 'OK';
  }
}

interface LegacySquadCreationBlocker {
  mount(): Promise<void>;
  unmount(): Promise<void>;
}

test('legacy facade supplies authoritative squad creator state to the unchanged blocker', async () => {
  const imported = (await import(
    pathToFileURL(resolve('squad-server/plugins/squad-creation-blocker.js')).href
  )) as {
    default: new (
      server: unknown,
      options: Record<string, unknown>,
      connectors: Record<string, unknown>
    ) => LegacySquadCreationBlocker;
  };
  const state = new ServerState();
  const rcon = new FakeRcon();
  const host = new LegacyServerHost({ state, rcon });
  const facade = host.createFacade('SquadCreationBlocker');
  const refresher = new StateRefresher(state, rcon);
  const plugin = new imported.default(
    facade,
    {
      blockDuration: 11,
      broadcastMode: true,
      allowDefaultSquadNames: true,
      rateLimitEnforced: false
    },
    {}
  );
  let eventDelivered = (): void => undefined;
  const delivered = new Promise<void>((resolveEvent) => {
    eventDelivered = resolveEvent;
  });
  let bridgeError: Error | undefined;

  await plugin.mount();
  facade.on('SQUAD_CREATED', eventDelivered);
  const stopBridge = startRconChatBridge(rcon, state, host, {
    refreshPlayers: () => refresher.refreshPlayers(),
    onError: (error) => void (bridgeError = error)
  });

  try {
    host.publish({ name: 'NEW_GAME', data: { time: new Date() } });
    rcon.emit('chat', {
      body: `Alpha (Online IDs:EOS: ${eosID} steam: ${steamID}) has created Squad 4 (Squad Name: Armor) on Red Team`
    } as RconPacket);
    await delivered;
    await host.drain();

    assert.equal(bridgeError, undefined);
    assert.deepEqual(rcon.commands, ['AdminDisbandSquad 2 4']);

    const defaultDelivered = new Promise<void>((resolveEvent) => {
      facade.once('SQUAD_CREATED', resolveEvent);
    });
    rcon.emit('chat', {
      body: `Alpha (Online IDs:EOS: ${eosID} steam: ${steamID}) has created Squad 5 (Squad Name: Squad 5) on Red Team`
    } as RconPacket);
    await defaultDelivered;
    await host.drain();
    assert.deepEqual(rcon.commands, ['AdminDisbandSquad 2 4']);
  } finally {
    stopBridge();
    await plugin.unmount();
    facade.dispose();
  }
});
