import assert from 'node:assert/strict';
import test from 'node:test';
import { LegacyRconFacade } from '../../src/compatibility/legacy-server-facade.js';
import { SquadRconClient, type RconConnectionState } from '../../src/rcon/client.js';

class RecoveringRcon extends SquadRconClient {
  currentState: RconConnectionState = 'disconnected';
  readonly broadcasts: string[] = [];

  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }

  override get state(): RconConnectionState {
    return this.currentState;
  }

  override async broadcast(message: string): Promise<void> {
    if (this.currentState !== 'ready') throw new Error('RCON client is not ready');
    this.broadcasts.push(message);
  }

  recover(): void {
    this.currentState = 'ready';
    this.emit('state', 'ready');
  }
}

test('legacy broadcasts wait briefly for RCON recovery and retry once', async () => {
  const rcon = new RecoveringRcon();
  const facade = new LegacyRconFacade(rcon, 100);
  const broadcast = facade.broadcast('Round message');
  setImmediate(() => rcon.recover());

  await broadcast;
  assert.deepEqual(rcon.broadcasts, ['Round message']);
  assert.equal(rcon.listenerCount('state'), 0);
});

test('legacy broadcasts expire instead of being replayed after a long outage', async () => {
  const rcon = new RecoveringRcon();
  const facade = new LegacyRconFacade(rcon, 10);

  await assert.rejects(facade.broadcast('Expired message'), /did not recover within 10ms/);
  rcon.recover();
  assert.deepEqual(rcon.broadcasts, []);
  assert.equal(rcon.listenerCount('state'), 0);
});
