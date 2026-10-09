import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import { LocalTailReader } from '../../src/logs/local-tail-reader.js';
import logGrabber from '../../src/plugins/builtin/log-grabber.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';

class FakeRcon extends SquadRconClient {
  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }
}

class FakeDiscord extends EventEmitter {
  readonly commandID = 'log-command';
  readonly commands = new Map([['unrelated', { id: 'unrelated', name: 'unrelated', type: 1 }]]);
  readonly created: unknown[] = [];
  readonly edited: unknown[] = [];
  readonly guild = {
    id: 'guild',
    commands: {
      fetch: async () => this.commands,
      create: async (data: { readonly name: string; readonly type: number }) => {
        this.created.push(data);
        const command = { id: this.commandID, ...data };
        this.commands.set(this.commandID, command);
        return command;
      },
      edit: async (id: string, data: unknown) => {
        this.edited.push({ id, data });
        return { id, ...(data as object) };
      }
    }
  };
  readonly guilds = { fetch: async () => this.guild };
}

test('logGrabber registers one command, authorizes requests, uploads gzip, and cleans up', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-log-grabber-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'SquadGame.log');
  await writeFile(source, 'Squad server log\n', 'utf8');
  const discord = new FakeDiscord();
  const state = new ServerState();
  const rcon = new FakeRcon();
  const events = new LegacyServerHost({ state, rcon });
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry({ discord }),
    logs: new LocalTailReader({ path: source })
  });
  await runtime.mount(
    'logGrabber',
    logGrabber.create(),
    {
      guildID: 'guild',
      commandName: 'server-log',
      allowedRoleIDs: ['staff'],
      allowedChannelIDs: [],
      allowAdministrator: false,
      ephemeral: false,
      maximumSourceBytes: 1024
    },
    { discord: 'discord' }
  );

  const deniedReplies: unknown[] = [];
  discord.emit(
    'interactionCreate',
    interaction(discord.commandID, {
      roles: ['member'],
      reply: async (response) => void deniedReplies.push(response)
    })
  );
  await waitFor(() => deniedReplies.length === 1);
  assert.match(String((deniedReplies[0] as { content: string }).content), /not authorized/);

  let uploaded: Buffer | undefined;
  let uploadedPath: string | undefined;
  const edits: unknown[] = [];
  const successful = interaction(discord.commandID, {
    roles: ['staff'],
    editReply: async (response) => {
      const file = (response as { files: { attachment: string }[] }).files[0];
      if (file) {
        uploadedPath = file.attachment;
        uploaded = await readFile(file.attachment);
      }
      edits.push(response);
    }
  });
  discord.emit('interactionCreate', successful);
  await waitFor(() => edits.length === 1);

  assert.equal(gunzipSync(uploaded!).toString('utf8'), 'Squad server log\n');
  assert.equal(successful.deferReplyOptions, undefined);
  assert.equal(discord.created.length, 1);
  assert.equal(discord.commands.has('unrelated'), true);
  await waitFor(async () => {
    if (!uploadedPath) return false;
    try {
      await stat(uploadedPath);
      return false;
    } catch {
      return true;
    }
  });

  await runtime.stop();
  assert.equal(discord.listenerCount('interactionCreate'), 0);
});

function interaction(
  commandID: string,
  overrides: {
    readonly roles: readonly string[];
    readonly reply?: (response: unknown) => Promise<void>;
    readonly editReply?: (response: unknown) => Promise<void>;
  }
) {
  const value = {
    commandId: commandID,
    guildId: 'guild',
    channelId: 'channel',
    attachmentSizeLimit: 10 * 1024 * 1024,
    user: { id: 'requester' },
    member: { roles: [...overrides.roles] },
    memberPermissions: { has: () => false },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    inGuild: () => true,
    deferReplyOptions: undefined as unknown,
    deferReply: async (options?: unknown) => {
      value.deferred = true;
      value.deferReplyOptions = options;
    },
    reply: async (response: unknown) => {
      value.replied = true;
      await overrides.reply?.(response);
    },
    editReply: async (response: unknown) => overrides.editReply?.(response)
  };
  return value;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for logGrabber');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}
