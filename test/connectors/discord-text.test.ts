import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordTextConnector } from '../../src/connectors/discord-text.js';

test('posts a Discord message without exposing the token in its result', async () => {
  let requestedUrl = '';
  let authorization = '';
  let requestBody = '';
  const connector = new DiscordTextConnector({
    token: 'test-token',
    fetch: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      requestBody = String(init?.body);
      return Response.json({ id: '12345678901234567', channel_id: '23456789012345678' });
    }
  });

  const receipt = await connector.sendMessage('23456789012345678', 'hello');
  assert.equal(requestedUrl, 'https://discord.com/api/v10/channels/23456789012345678/messages');
  assert.equal(authorization, 'Bot test-token');
  assert.deepEqual(JSON.parse(requestBody), { content: 'hello' });
  assert.deepEqual(receipt, {
    id: '12345678901234567',
    channelID: '23456789012345678'
  });
  assert.equal(JSON.stringify(receipt).includes('test-token'), false);
});

test('reports Discord failures without echoing response content or credentials', async () => {
  const connector = new DiscordTextConnector({
    token: 'secret-token',
    fetch: async () => new Response('sensitive upstream response', { status: 403 })
  });

  await assert.rejects(
    connector.sendMessage('23456789012345678', 'hello'),
    (error: Error) => error.message === 'Discord message failed with HTTP 403'
  );
});
