import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface RawChatMessage {
  content: string;
  allowedMentions: { parse: string[] };
}
interface RawChatPlugin {
  channel: { send(message: RawChatMessage): Promise<void> };
  onChatMessage(info: Record<string, unknown>): Promise<void>;
}
const { default: DiscordChatRaw } = (await import(
  pathToFileURL(resolve('squad-server/plugins/discord-chat-raw.js')).href
)) as {
  default: new (
    server: unknown,
    options: Record<string, unknown>,
    connectors: Record<string, unknown>
  ) => RawChatPlugin;
};
function fixture() {
  const messages: RawChatMessage[] = [];
  const plugin = new DiscordChatRaw(
    { id: 7 },
    { discordClient: 'discord', channelID: 'logs' },
    { discord: {} }
  );
  plugin.channel = {
    send: async (message) => {
      messages.push(message);
    }
  };
  return { plugin, messages };
}

test('raw chat logs retain the message while disabling Discord mentions', async () => {
  const { plugin, messages } = fixture();
  const message = 'Hello @everyone and <@123456789012345678>';
  await plugin.onChatMessage({
    chat: 'ChatAll',
    player: { name: 'Sample' },
    steamID: '76561198000000001',
    message
  });
  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.content.startsWith('SERVER7 [ChatAll] [Sample]'));
  assert.ok(messages[0]!.content.endsWith('`' + message + '`'));
  assert.deepEqual(messages[0]!.allowedMentions, { parse: [] });
});

test('raw chat keeps configured ignored chats silent', async () => {
  const { plugin, messages } = fixture();
  await plugin.onChatMessage({ chat: 'ChatSquad', player: { name: 'Sample' }, message: 'ignored' });
  assert.equal(messages.length, 0);
});
