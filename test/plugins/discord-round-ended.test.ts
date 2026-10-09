import assert from 'node:assert/strict';
import test from 'node:test';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import discordRoundEnded from '../../src/plugins/builtin/discord-round-ended.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';

const firstChannelID = '111111111111111111';
const secondChannelID = '222222222222222222';

class FakeRcon extends SquadRconClient {
  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }
}

class FakeChannel {
  readonly messages: unknown[] = [];

  constructor(readonly failure?: Error) {}

  isSendable(): boolean {
    return true;
  }

  async send(message: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    this.messages.push(message);
  }
}

class FakeDiscord {
  readonly fetched: string[] = [];
  readonly channels: {
    fetch: (id: string) => Promise<FakeChannel | null>;
  };

  constructor(channelMap: ReadonlyMap<string, FakeChannel>) {
    this.channels = {
      fetch: async (id) => {
        this.fetched.push(id);
        return channelMap.get(id) ?? null;
      }
    };
  }
}

test('native discordRoundEnded posts one result to each unique configured channel', async () => {
  const first = new FakeChannel();
  const second = new FakeChannel();
  const discord = new FakeDiscord(
    new Map([
      [firstChannelID, first],
      [secondChannelID, second]
    ])
  );
  const { runtime, events } = createRuntime(discord);

  await runtime.mount(
    'discordRoundEnded',
    discordRoundEnded.create(),
    {
      channelIDs: [firstChannelID, secondChannelID, firstChannelID],
      color: 123
    },
    { discord: 'discord' }
  );
  events.publish({
    name: 'ROUND_ENDED',
    data: {
      time: new Date('2026-08-15T12:00:00Z'),
      winner: {
        team: 1,
        subfaction: 'Infantry',
        faction: 'USA',
        tickets: 42,
        layer: 'Gorodok_AAS_v1',
        level: 'Gorodok'
      },
      loser: {
        team: 2,
        subfaction: 'Armour',
        faction: 'Russia',
        tickets: 0,
        layer: 'Gorodok_AAS_v1',
        level: 'Gorodok'
      }
    }
  });

  await waitFor(() => first.messages.length === 1 && second.messages.length === 1);
  assert.deepEqual(discord.fetched, [firstChannelID, secondChannelID]);
  assert.deepEqual(first.messages, second.messages);
  assert.deepEqual(first.messages[0], {
    embeds: [
      {
        title: 'Round Ended',
        description: 'Gorodok_AAS_v1 - Gorodok',
        color: 123,
        fields: [
          {
            name: 'Team 1 Won',
            value: 'Infantry\n USA\n won with 42 tickets.'
          },
          {
            name: 'Team 2 Lost',
            value: 'Armour\n Russia\n lost with 0 tickets.'
          },
          { name: 'Ticket Difference', value: '42.' }
        ],
        timestamp: '2026-08-15T12:00:00.000Z'
      }
    ]
  });

  await runtime.stop();
  events.publish({
    name: 'ROUND_ENDED',
    data: { time: new Date(), winner: null, loser: null }
  });
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1);
});

test('native discordRoundEnded keeps other deliveries working when one channel fails', async () => {
  const good = new FakeChannel();
  const bad = new FakeChannel(new Error('send failed'));
  const goodChannelID = '333333333333333333';
  const badChannelID = '444444444444444444';
  const discord = new FakeDiscord(
    new Map([
      [goodChannelID, good],
      [badChannelID, bad]
    ])
  );
  const failures: unknown[] = [];
  const { runtime, events } = createRuntime(discord, (_plugin, level, message, details) => {
    if (level === 'error') failures.push({ message, details });
  });

  await runtime.mount(
    'discordRoundEnded',
    discordRoundEnded.create(),
    { channelIDs: [goodChannelID, badChannelID], color: 123 },
    { discord: 'discord' }
  );
  events.publish({
    name: 'ROUND_ENDED',
    data: { time: new Date('2026-08-15T12:00:00Z'), winner: null, loser: null }
  });

  await waitFor(() => good.messages.length === 1);
  await runtime.stop();
  assert.equal(bad.messages.length, 0);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], {
    message: 'Failed to deliver round result',
    details: {
      event: 'discord_round_ended_delivery',
      channelID: badChannelID,
      error: 'send failed'
    }
  });
});

test('native discordRoundEnded rejects an empty or invalid channel list before fetching', async () => {
  const discord = new FakeDiscord(new Map());
  const { runtime } = createRuntime(discord);

  await assert.rejects(
    runtime.mount(
      'discordRoundEnded',
      discordRoundEnded.create(),
      { channelIDs: [], color: 123 },
      { discord: 'discord' }
    ),
    /At least one channelIDs entry is required/
  );
  await assert.rejects(
    runtime.mount(
      'discordRoundEnded',
      discordRoundEnded.create(),
      { channelIDs: ['not-a-channel-id'], color: 123 },
      { discord: 'discord' }
    ),
    /channelIDs must contain only Discord channel IDs/
  );
  assert.deepEqual(discord.fetched, []);
  await runtime.stop();
});

function createRuntime(
  discord: FakeDiscord,
  logger?: (
    plugin: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    details?: unknown
  ) => void
): { readonly runtime: PluginRuntime; readonly events: LegacyServerHost } {
  const state = new ServerState();
  const rcon = new FakeRcon();
  const events = new LegacyServerHost({ state, rcon });
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry({ discord }),
    ...(logger ? { logger } : {})
  });
  return { runtime, events };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for discordRoundEnded');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}
