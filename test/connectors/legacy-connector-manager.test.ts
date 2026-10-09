import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Sequelize } from 'sequelize';
import {
  installLegacyEventAliases,
  LegacyConnectorManager
} from '../../src/connectors/legacy-connector-manager.js';

test('adds the removeEventListener alias expected by legacy Discord plugins', () => {
  const client = new EventEmitter();
  let calls = 0;
  const listener = (): void => {
    calls += 1;
  };

  installLegacyEventAliases(client);
  client.on('messageCreate', listener);
  client.emit('messageCreate');
  (
    client as EventEmitter & {
      removeEventListener: (event: string, listener: () => void) => EventEmitter;
    }
  ).removeEventListener('messageCreate', listener);
  client.emit('messageCreate');

  assert.equal(calls, 1);
});

test('connector shutdown closes every connector even when one close fails', async () => {
  const manager = new LegacyConnectorManager();
  await manager.initialize(
    [
      { name: 'first', type: 'sequelize', plugin: 'FirstPlugin' },
      { name: 'second', type: 'sequelize', plugin: 'SecondPlugin' }
    ],
    {
      first: { dialect: 'sqlite', storage: ':memory:' },
      second: { dialect: 'sqlite', storage: ':memory:' }
    }
  );
  const first = manager.registry.get('first') as Sequelize;
  const second = manager.registry.get('second') as Sequelize;
  let firstClosed = false;
  const closeFirst = first.close.bind(first);
  const closeSecond = second.close.bind(second);
  first.close = async () => {
    firstClosed = true;
    await closeFirst();
  };
  second.close = async () => {
    await closeSecond();
    throw new Error('simulated close failure');
  };

  await assert.rejects(manager.stop(), /Failed to close one or more connectors/);
  assert.equal(firstClosed, true);
  assert.throws(() => manager.registry.get('first'), /not configured/);
});
