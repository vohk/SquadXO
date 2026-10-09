import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  ApplicationCommandType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction
} from 'discord.js';
import { definePlugin, type PluginContext } from '../api.js';

const COMMAND_DESCRIPTION = 'Archive and download the current Squad server log.';

const options = {
  guildID: {
    type: 'string',
    required: true,
    description: 'Discord guild where the slash command is registered.'
  },
  commandName: {
    type: 'string',
    default: 'server-log',
    description: 'Guild slash-command name.'
  },
  allowedRoleIDs: {
    type: 'string[]',
    default: [],
    description: 'Discord roles permitted to download the server log.'
  },
  allowedChannelIDs: {
    type: 'string[]',
    default: [],
    description: 'Channels where the command may run; empty permits every guild channel.'
  },
  allowAdministrator: {
    type: 'boolean',
    default: true,
    description: 'Permit members with Discord Administrator permission.'
  },
  ephemeral: {
    type: 'boolean',
    default: false,
    description: 'Send successful log downloads as ephemeral interaction responses.'
  },
  maximumSourceBytes: {
    type: 'number',
    default: 2_147_483_648,
    description: 'Maximum uncompressed SquadGame.log size accepted for one request.'
  }
} as const;

const connectors = {
  discord: {
    type: 'discord',
    description: 'Discord bot used to register and answer the slash command.'
  }
} as const;

type LogGrabberContext = PluginContext<
  {
    readonly guildID: string;
    readonly commandName: string;
    readonly allowedRoleIDs: readonly string[];
    readonly allowedChannelIDs: readonly string[];
    readonly allowAdministrator: boolean;
    readonly ephemeral: boolean;
    readonly maximumSourceBytes: number;
  },
  typeof connectors
>;

export default definePlugin({
  apiVersion: 1,
  name: 'logGrabber',
  description: 'Provides a permission-controlled Discord command for bounded server-log downloads.',
  options,
  connectors,
  create() {
    let discord: Client | undefined;
    let interactionListener: ((interaction: Interaction) => void) | undefined;

    return {
      async mount(context) {
        validateOptions(context);
        discord = context.connector('discord');
        const guild = await discord.guilds.fetch(context.options.guildID);
        const commands = await guild.commands.fetch();
        const existing = [...commands.values()].find(
          (command) => command.name === context.options.commandName
        );
        if (existing && existing.type !== ApplicationCommandType.ChatInput) {
          throw new Error(
            `Discord command name is already used by a non-chat command: ${context.options.commandName}`
          );
        }
        const commandData = {
          name: context.options.commandName,
          description: COMMAND_DESCRIPTION,
          type: ApplicationCommandType.ChatInput as const
        };
        const command = existing
          ? await guild.commands.edit(existing.id, commandData)
          : await guild.commands.create(commandData);

        let exportRunning = false;
        interactionListener = (interaction) => {
          if (!interaction.isChatInputCommand() || interaction.commandId !== command.id) return;
          context.track(
            handleInteraction(context, interaction, {
              isRunning: () => exportRunning,
              setRunning: (running) => {
                exportRunning = running;
              }
            })
          );
        };
        discord.on('interactionCreate', interactionListener);
        context.logger.info('Mounted', {
          event: 'log_grabber_mounted',
          guildID: guild.id,
          commandName: context.options.commandName,
          commandID: command.id
        });
      },

      unmount() {
        if (discord && interactionListener) {
          discord.removeListener('interactionCreate', interactionListener);
        }
        discord = undefined;
        interactionListener = undefined;
      }
    };
  }
});

async function handleInteraction(
  context: LogGrabberContext,
  interaction: ChatInputCommandInteraction,
  state: { readonly isRunning: () => boolean; readonly setRunning: (running: boolean) => void }
): Promise<void> {
  if (!interaction.inGuild() || interaction.guildId !== context.options.guildID) {
    await interaction.reply({
      content: 'This command is only available in its configured server.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (!authorized(context, interaction)) {
    await interaction.reply({
      content: 'You are not authorized to download the server log.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (
    context.options.allowedChannelIDs.length > 0 &&
    (!interaction.channelId || !context.options.allowedChannelIDs.includes(interaction.channelId))
  ) {
    await interaction.reply({
      content: 'This command is not available in this channel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (state.isRunning()) {
    await interaction.reply({
      content: 'Another server-log export is already in progress. Try again shortly.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  state.setRunning(true);
  const startedAt = Date.now();
  let directory: string | undefined;
  try {
    if (context.options.ephemeral) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply();
    }
    directory = await mkdtemp(join(tmpdir(), 'squadxo-log-grabber-'));
    const snapshotPath = join(directory, 'SquadGame.log');
    const snapshot = await context.logs.copyCurrent(snapshotPath, {
      maximumBytes: context.options.maximumSourceBytes
    });
    const archiveName = `SquadGame-${timestamp(new Date())}.log.gz`;
    const archivePath = join(directory, archiveName);
    await pipeline(
      createReadStream(snapshotPath),
      createGzip(),
      createWriteStream(archivePath, { flags: 'wx' }),
      { signal: context.signal }
    );
    const archiveBytes = (await stat(archivePath)).size;
    if (archiveBytes > interaction.attachmentSizeLimit) {
      throw new AttachmentTooLargeError(archiveBytes, interaction.attachmentSizeLimit);
    }
    await interaction.editReply({
      content: 'Current Squad server log:',
      files: [{ attachment: archivePath, name: archiveName }]
    });
    context.logger.info('Log export completed', {
      event: 'log_export',
      outcome: 'success',
      userID: interaction.user.id,
      guildID: interaction.guildId,
      channelID: interaction.channelId,
      sourceBytes: snapshot.sourceBytes,
      archiveBytes,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    if (!context.signal.aborted) {
      context.logger.error('Log export failed', {
        event: 'log_export',
        outcome: 'failure',
        userID: interaction.user.id,
        guildID: interaction.guildId,
        channelID: interaction.channelId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      await replyWithFailure(interaction, error);
    }
  } finally {
    state.setRunning(false);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function validateOptions(context: LogGrabberContext): void {
  if (!context.options.guildID) throw new Error('guildID must be a non-empty Discord guild ID');
  if (!/^[a-z0-9_-]{1,32}$/.test(context.options.commandName)) {
    throw new Error(
      'commandName must contain 1-32 lowercase letters, numbers, hyphens, or underscores'
    );
  }
  if (
    !Number.isSafeInteger(context.options.maximumSourceBytes) ||
    context.options.maximumSourceBytes < 1
  ) {
    throw new Error('maximumSourceBytes must be a positive safe integer');
  }
  if (!context.options.allowAdministrator && context.options.allowedRoleIDs.length === 0) {
    throw new Error('At least one allowedRoleID is required when allowAdministrator is false');
  }
}

function authorized(
  context: LogGrabberContext,
  interaction: ChatInputCommandInteraction<'raw' | 'cached'>
): boolean {
  if (
    context.options.allowAdministrator &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  const roles = interaction.member?.roles;
  const roleIDs = Array.isArray(roles)
    ? roles
    : roles && 'cache' in roles
      ? [...roles.cache.keys()]
      : [];
  return roleIDs.some((roleID) => context.options.allowedRoleIDs.includes(roleID));
}

async function replyWithFailure(
  interaction: ChatInputCommandInteraction,
  error: unknown
): Promise<void> {
  let content = 'Could not capture the Squad server log. Check the SquadXO console for details.';
  if (error instanceof AttachmentTooLargeError) {
    content = `The compressed log is ${formatBytes(error.actual)} and exceeds Discord's ${formatBytes(
      error.maximum
    )} attachment limit.`;
  } else if (error instanceof Error && error.message.startsWith('Squad log is ')) {
    content = 'The server log exceeds the configured maximumSourceBytes limit.';
  }
  if (interaction.deferred || interaction.replied)
    await interaction.editReply({ content, files: [] });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

class AttachmentTooLargeError extends Error {
  constructor(
    readonly actual: number,
    readonly maximum: number
  ) {
    super(`Compressed log is ${actual} bytes; Discord attachment limit is ${maximum} bytes`);
  }
}

function timestamp(date: Date): string {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('T', '_').slice(0, 15);
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
