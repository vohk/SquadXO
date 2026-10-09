import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import discordOperations from '../../src/plugins/builtin/discord-operations.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';

class FakeRcon extends SquadRconClient {
  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }
}

class FakeDiscord extends EventEmitter {
  readonly commandID = 'operations-command';
  readonly guildCommands = new Map([
    ['active-command', { id: 'active-command', name: 'server-log', type: 1 }]
  ]);
  readonly globalCommands = new Map([
    ['stale-command', { id: 'stale-command', name: 'staff-request', type: 1 }]
  ]);
  readonly guildDeleted: string[] = [];
  readonly globalDeleted: string[] = [];
  guildClearCount = 0;
  globalClearCount = 0;
  readonly guild = {
    id: 'guild',
    commands: {
      fetch: async () => this.guildCommands,
      create: async (data: { readonly name: string; readonly type: number }) => {
        const command = { id: this.commandID, ...data };
        this.guildCommands.set(this.commandID, command);
        return command;
      },
      edit: async (id: string, data: unknown) => ({ id, ...(data as object) }),
      delete: async (id: string) => {
        this.guildDeleted.push(id);
        this.guildCommands.delete(id);
      },
      set: async () => {
        this.guildClearCount += 1;
        this.guildCommands.clear();
        return this.guildCommands;
      }
    }
  };
  readonly guilds = { fetch: async () => this.guild };
  readonly application = {
    commands: {
      fetch: async () => this.globalCommands,
      delete: async (id: string) => {
        this.globalDeleted.push(id);
        this.globalCommands.delete(id);
      },
      set: async () => {
        this.globalClearCount += 1;
        this.globalCommands.clear();
        return this.globalCommands;
      }
    }
  };
}

test('discordOperations lists both scopes and locates a stale global command', async () => {
  const discord = new FakeDiscord();
  const runtime = runtimeFor(discord);
  await mount(runtime);

  const listed = interaction(discord.commandID, { roles: ['staff'] });
  discord.emit('interactionCreate', listed.value);
  await waitFor(() => listed.replies.length === 1);
  assert.match(listed.replies[0]!, /staff-request/);
  assert.match(listed.replies[0]!, /server-log/);
  assert.equal(discord.globalCommands.has('stale-command'), true);

  const removed = interaction(discord.commandID, { roles: ['staff'], name: 'staff-request' });
  discord.emit('interactionCreate', removed.value);
  await waitFor(() => removed.edits.length === 1);
  assert.deepEqual(discord.globalDeleted, ['stale-command']);
  assert.deepEqual(discord.guildDeleted, []);
  assert.equal(discord.guildCommands.has('active-command'), true);
  assert.equal(discord.guildCommands.has(discord.commandID), true);

  await runtime.stop();
  assert.equal(discord.listenerCount('interactionCreate'), 0);
});

test('discordOperations authorizes cleanup and requires an explicit bulk scope', async () => {
  const discord = new FakeDiscord();
  const runtime = runtimeFor(discord);
  await mount(runtime);

  const denied = interaction(discord.commandID, { roles: ['member'], all: true });
  discord.emit('interactionCreate', denied.value);
  await waitFor(() => denied.replies.length === 1);
  assert.match(denied.replies[0]!, /not authorized/);
  assert.equal(discord.globalClearCount, 0);

  const missingScope = interaction(discord.commandID, { roles: ['staff'], all: true });
  discord.emit('interactionCreate', missingScope.value);
  await waitFor(() => missingScope.replies.length === 1);
  assert.match(missingScope.replies[0]!, /explicit scope/);
  assert.equal(discord.globalClearCount, 0);

  const cleared = interaction(discord.commandID, {
    roles: ['staff'],
    all: true,
    scope: 'global'
  });
  discord.emit('interactionCreate', cleared.value);
  await waitFor(() => cleared.edits.length === 1);
  assert.equal(discord.globalClearCount, 1);
  assert.equal(discord.globalCommands.size, 0);
  assert.equal(discord.guildCommands.size, 2);
  assert.match(cleared.edits[0]!, /Restart active command plugins/);

  await runtime.stop();
});

function runtimeFor(discord: FakeDiscord): PluginRuntime {
  const state = new ServerState();
  const rcon = new FakeRcon();
  return new PluginRuntime({
    state,
    rcon,
    events: new LegacyServerHost({ state, rcon }),
    connectors: new ConnectorRegistry({ discord })
  });
}

async function mount(runtime: PluginRuntime): Promise<void> {
  await runtime.mount(
    'discordOperations',
    discordOperations.create(),
    {
      guildID: 'guild',
      commandName: 'clear-application-commands',
      allowedRoleIDs: ['staff'],
      allowAdministrator: false
    },
    { discord: 'discord' }
  );
}

function interaction(
  commandID: string,
  options: {
    readonly roles: readonly string[];
    readonly name?: string;
    readonly all?: boolean;
    readonly scope?: 'guild' | 'global';
  }
) {
  const replies: string[] = [];
  const edits: string[] = [];
  const value = {
    commandId: commandID,
    guildId: 'guild',
    channelId: 'channel',
    user: { id: 'requester' },
    member: { roles: [...options.roles] },
    memberPermissions: { has: () => false },
    options: {
      getString: (name: string) =>
        name === 'name'
          ? (options.name ?? null)
          : name === 'scope'
            ? (options.scope ?? null)
            : null,
      getBoolean: (name: string) => (name === 'all' ? (options.all ?? null) : null)
    },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    inGuild: () => true,
    deferReply: async () => {
      value.deferred = true;
    },
    reply: async (response: { readonly content: string }) => {
      value.replied = true;
      replies.push(response.content);
    },
    editReply: async (response: string | { readonly content: string }) => {
      edits.push(typeof response === 'string' ? response : response.content);
    }
  };
  return { value, replies, edits };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for discordOperations');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}
