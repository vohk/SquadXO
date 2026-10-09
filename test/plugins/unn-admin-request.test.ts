import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface AdminRequestPlugin {
  requestsByPlayer: Map<string, object>;
  prepareToMount(): Promise<void>;
  mount(): Promise<void>;
  unmount(): Promise<void>;
  onChatCommand(info: Record<string, unknown>): Promise<void>;
  onChatMessage(info: Record<string, unknown>): Promise<void>;
  onDiscordMessage(message: Record<string, unknown>): Promise<void>;
  onDiscordInteraction(interaction: Record<string, unknown>): Promise<void>;
}

test('unnAdminRequest relays, claims, completes, and releases resources', async () => {
  const { default: unnAdminRequest } = (await import(
    pathToFileURL(resolve('squad-server/plugins/unn-admin-request.js')).href
  )) as {
    default: {
      new (
        server: unknown,
        options: Record<string, unknown>,
        connectors: Record<string, unknown>
      ): AdminRequestPlugin;
      optionsSpecification: {
        autocloseAfterMinutes: { default: number };
      };
    };
  };

  assert.equal(unnAdminRequest.optionsSpecification.autocloseAfterMinutes.default, 10);

  const threadMessages: unknown[] = [];
  const parentMessages: unknown[] = [];
  const messageEdits: unknown[] = [];
  const interactionUpdates: unknown[] = [];
  let archived = false;
  const thread = {
    id: 'thread-1',
    send: async (message: unknown) => void threadMessages.push(message),
    setArchived: async (value: boolean) => {
      archived = value;
    }
  };
  const sentMessage = {
    id: 'message-1',
    embeds: [] as { toJSON(): Record<string, unknown> }[],
    components: [] as { toJSON(): Record<string, unknown> }[],
    startThread: async () => thread,
    edit: async (message: unknown) => void messageEdits.push(message)
  };
  const channel = {
    isTextBased: () => true,
    send: async (message: Record<string, unknown>) => {
      parentMessages.push(message);
      sentMessage.embeds = (message.embeds as Record<string, unknown>[]).map((embed) => ({
        toJSON: () => structuredClone(embed)
      }));
      sentMessage.components = (message.components as Record<string, unknown>[]).map(
        (component) => ({ toJSON: () => structuredClone(component) })
      );
      return sentMessage;
    }
  };
  const discord = new EventEmitter() as EventEmitter & {
    channels: { fetch(id: string): Promise<typeof channel> };
  };
  discord.channels = { fetch: async () => channel };

  const requester = {
    eosID: '11111111111111111111111111111111',
    steamID: '76561198000000001',
    name: 'Requester',
    teamID: 2,
    squadID: 4,
    role: 'IMF_Rifleman_01'
  };
  const admin = {
    eosID: '22222222222222222222222222222222',
    steamID: '76561198000000002',
    name: 'AdminPlayer',
    teamID: 1,
    squadID: 1,
    role: 'USMC_Rifleman_01'
  };
  const otherAdmin = {
    eosID: '33333333333333333333333333333333',
    steamID: '76561198000000003',
    name: 'OtherAdmin',
    teamID: 1,
    squadID: 2,
    role: 'USMC_Medic_01'
  };
  const anotherAdmin = {
    eosID: '44444444444444444444444444444444',
    steamID: '76561198000000004',
    name: 'YetAnotherAdminUsername',
    teamID: 2,
    squadID: 4,
    role: 'IMF_SquadLeader_01'
  };
  const warnings: { target: string; message: string }[] = [];
  const server = new EventEmitter() as EventEmitter & {
    players: (typeof requester)[];
    squads: { teamID: number; teamName: string; squadID: number; squadName: string }[];
    rcon: { warn(target: string, message: string): Promise<void> };
    getAdminsWithPermission(permission: string, idType: string): Promise<string[]>;
    removeEventListener(event: string, listener: (...arguments_: unknown[]) => void): EventEmitter;
  };
  server.players = [requester, admin, otherAdmin, anotherAdmin];
  server.squads = [
    { teamID: 1, teamName: 'United States Marine Corps', squadID: 1, squadName: 'Squad 1' },
    { teamID: 2, teamName: 'Irregular Light Infantry', squadID: 4, squadName: 'Squad 4' }
  ];
  server.rcon = {
    warn: async (target, message) => void warnings.push({ target, message })
  };
  server.getAdminsWithPermission = async () => [admin.eosID, otherAdmin.eosID, anotherAdmin.eosID];
  server.removeEventListener = (event, listener) => server.removeListener(event, listener);

  const plugin = new unnAdminRequest(
    server,
    {
      discordClient: 'discord',
      channelID: 'channel-1',
      command: 'admin',
      pingGroups: ['role-1'],
      pingDelay: 60_000,
      warnInGameAdmins: true,
      showInGameAdmins: true,
      autocloseAfterMinutes: 10
    },
    { discord }
  );

  await plugin.prepareToMount();
  await plugin.mount();
  try {
    await plugin.onChatCommand({
      player: requester,
      chat: 'ChatAll',
      message: 'I need help',
      time: new Date('2026-08-16T12:00:00Z')
    });
    assert.equal(parentMessages.length, 1);
    assert.equal(plugin.requestsByPlayer.size, 1);
    const requestEmbed = (
      parentMessages[0] as {
        embeds: {
          fields: { name: string; value: string }[];
          footer: { text: string };
        }[];
      }
    ).embeds[0];
    assert.deepEqual(
      requestEmbed?.fields.map((field) => field.name),
      ['Player', 'Team & Squad', 'Message', 'Admins Online: 3']
    );
    assert.equal(
      requestEmbed?.fields[0]?.value,
      '[Requester](https://www.battlemetrics.com/rcon/players?filter[search]=' +
        `${requester.eosID}&method=quick&redirect=1)`
    );
    assert.equal(
      requestEmbed?.fields.find((field) => field.name === 'Team & Squad')?.value,
      'Team: 2 (IMF), Squad: 4 (Squad 4)'
    );
    assert.equal(
      requestEmbed?.fields.find((field) => field.name === 'Admins Online: 3')?.value,
      'Team 1 (USMC)\n- AdminPlayer\n- OtherAdmin\nTeam 2 (IMF)\n- YetAnotherAdminUsername'
    );
    assert.equal(
      requestEmbed?.footer.text,
      `Made by JetDave, modified by Unn.\nCopyright © ${new Date().getFullYear()}`
    );
    assert.deepEqual(warnings[0], {
      target: admin.eosID,
      message: '[Requester] - I need help'
    });

    const warningCountBeforeRepeat = warnings.length;
    await plugin.onChatCommand({
      player: requester,
      chat: 'ChatAll',
      message: 'Still need help',
      time: new Date('2026-08-16T12:01:00Z')
    });
    assert.equal(parentMessages.length, 1);
    assert.equal(warnings.length, warningCountBeforeRepeat);

    await plugin.onChatMessage({ player: requester, chat: 'ChatAll', message: 'More detail' });
    assert.equal(threadMessages.length, 1);

    await plugin.onDiscordMessage({
      author: { bot: false, username: 'Helper' },
      member: { displayName: 'Helper' },
      channelId: thread.id,
      content: 'We are checking',
      attachments: new Map()
    });
    assert.deepEqual(warnings.at(-1), {
      target: requester.eosID,
      message: '[ADMIN] Helper: We are checking'
    });

    await plugin.onDiscordInteraction({
      isButton: () => true,
      customId: 'toggle-claim',
      message: sentMessage,
      user: { id: 'discord-admin' },
      update: async (message: unknown) => void interactionUpdates.push(message)
    });
    assert.equal(interactionUpdates.length, 1);

    await plugin.onDiscordInteraction({
      isButton: () => true,
      customId: 'completed',
      message: sentMessage,
      user: { id: 'discord-admin' },
      update: async (message: unknown) => void interactionUpdates.push(message)
    });
    assert.equal(archived, true);
    assert.equal(plugin.requestsByPlayer.size, 0);
    assert.equal(messageEdits.length, 0);
    assert.match(warnings.at(-1)?.message ?? '', /marked completed/);

    sentMessage.startThread = async () => {
      throw new Error('simulated thread creation failure');
    };
    await assert.rejects(
      plugin.onChatCommand({
        player: requester,
        chat: 'ChatAll',
        message: 'New request after completion',
        time: new Date('2026-08-16T12:02:00Z')
      }),
      /simulated thread creation failure/
    );
    const failureEdit = messageEdits.at(-1) as {
      embeds: { color: number; fields: { name: string; value: string }[] }[];
      components: unknown[];
    };
    assert.equal(failureEdit.embeds[0]?.color, 0xff0000);
    assert.equal(
      failureEdit.embeds[0]?.fields.find((field) => field.name === 'Message')?.value,
      'New request after completion'
    );
    assert.deepEqual(failureEdit.embeds[0]?.fields.at(-1), {
      name: 'Thread Creation Failed',
      value: 'Discord could not create a thread for this request. The player can try again.'
    });
    assert.deepEqual(failureEdit.components, []);
    assert.equal(plugin.requestsByPlayer.size, 0);
    sentMessage.startThread = async () => thread;
    await plugin.onChatCommand({
      player: requester,
      chat: 'ChatAll',
      message: 'Retry after thread failure',
      time: new Date('2026-08-16T12:03:00Z')
    });
    assert.equal(plugin.requestsByPlayer.size, 1);
  } finally {
    await plugin.unmount();
  }

  assert.equal(server.listenerCount('CHAT_COMMAND:admin'), 0);
  assert.equal(discord.listenerCount('interactionCreate'), 0);
  assert.equal(discord.listenerCount('messageCreate'), 0);
});

test('unnAdminRequest ignores repeat requests while the original request remains open', async () => {
  const { default: unnAdminRequest } = (await import(
    pathToFileURL(resolve('squad-server/plugins/unn-admin-request.js')).href
  )) as {
    default: new (
      server: unknown,
      options: Record<string, unknown>,
      connectors: Record<string, unknown>
    ) => AdminRequestPlugin;
  };
  const posts: unknown[] = [];
  const archivedThreads: string[] = [];
  const warnings: string[] = [];
  let sequence = 0;
  const channel = {
    isTextBased: () => true,
    send: async (payload: Record<string, unknown>) => {
      sequence += 1;
      posts.push(payload);
      const thread = {
        id: `thread-${sequence}`,
        send: async () => undefined,
        setArchived: async () => {
          archivedThreads.push(`thread-${sequence}`);
          if (sequence === 1) throw new Error('simulated Discord archive failure');
        }
      };
      return {
        id: `message-${sequence}`,
        embeds: (payload.embeds as Record<string, unknown>[]).map((embed) => ({
          toJSON: () => structuredClone(embed)
        })),
        components: [],
        startThread: async () => thread,
        edit: async () => undefined
      };
    }
  };
  const discord = new EventEmitter() as EventEmitter & {
    channels: { fetch(): Promise<typeof channel> };
  };
  discord.channels = { fetch: async () => channel };
  const server = new EventEmitter() as EventEmitter & {
    players: unknown[];
    rcon: { warn(target: string, message: string): Promise<void> };
    getAdminsWithPermission(): Promise<string[]>;
    removeEventListener(event: string, listener: (...arguments_: unknown[]) => void): EventEmitter;
  };
  server.players = [];
  server.rcon = { warn: async (_target, message) => void warnings.push(message) };
  server.getAdminsWithPermission = async () => [];
  server.removeEventListener = (event, listener) => server.removeListener(event, listener);
  const plugin = new unnAdminRequest(
    server,
    {
      discordClient: 'discord',
      channelID: 'channel',
      command: 'admin'
    },
    { discord }
  );
  const player = {
    eosID: '33333333333333333333333333333333',
    name: 'Requester',
    teamID: 1,
    squadID: 1,
    role: 'IMF_Rifleman_01'
  };
  server.players = [
    player,
    {
      eosID: '44444444444444444444444444444444',
      name: 'Opponent',
      teamID: 2,
      squadID: 1,
      role: 'USMC_Rifleman_01'
    }
  ];

  await plugin.prepareToMount();
  await plugin.mount();
  try {
    await plugin.onChatCommand({
      player,
      chat: 'ChatAll',
      message: 'First request',
      time: new Date()
    });
    const original = plugin.requestsByPlayer.get(player.eosID);
    assert.ok(original);
    const requestEmbed = (posts[0] as { embeds: { fields: { name: string; value: string }[] }[] })
      .embeds[0];
    assert.equal(
      requestEmbed?.fields.find((field) => field.name === 'Admins Online: 0')?.value,
      'Team 1 (IMF)\n- None\nTeam 2 (USMC)\n- None'
    );
    const warningCount = warnings.length;
    await plugin.onChatCommand({
      player,
      chat: 'ChatAll',
      message: 'Fresh request',
      time: new Date()
    });
    assert.equal(posts.length, 1);
    assert.deepEqual(archivedThreads, []);
    assert.equal(plugin.requestsByPlayer.get(player.eosID), original);
    assert.equal(warnings.length, warningCount);
  } finally {
    await plugin.unmount();
  }
});
