import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface CblInfoPlugin {
  verbose(...arguments_: unknown[]): void;
  onPlayerConnected(info: Record<string, unknown>): Promise<void>;
}

test('CBLInfo skips EOS-only players without issuing a Steam lookup', async () => {
  const { default: CBLInfo } = (await import(
    pathToFileURL(resolve('squad-server/plugins/cbl-info.js')).href
  )) as {
    default: new (
      server: unknown,
      options: Record<string, unknown>,
      connectors: Record<string, unknown>
    ) => CblInfoPlugin;
  };
  const server = new EventEmitter();
  const plugin = new CBLInfo(
    server,
    { discordClient: 'discord', channelID: 'channel', threshold: 6 },
    { discord: {} }
  );
  const messages: unknown[][] = [];
  plugin.verbose = (...arguments_: unknown[]) => void messages.push(arguments_);

  await plugin.onPlayerConnected({
    player: {
      eosID: '0002736161e34a308436a6e826768038',
      name: 'EOS-only player'
    },
    time: new Date('2026-08-23T02:14:40.565Z')
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.[0], 2);
  assert.match(String(messages[0]?.[1]), /no Steam ID is available/);
});
