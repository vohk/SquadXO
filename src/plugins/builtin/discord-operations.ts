import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction
} from 'discord.js';
import { definePlugin, type PluginContext } from '../api.js';

const COMMAND_DESCRIPTION = 'List or remove Discord application commands.';
type CommandScope = 'guild' | 'global';

const options = {
  guildID: {
    type: 'string',
    required: true,
    description: 'Discord guild where the operator command is registered.'
  },
  commandName: {
    type: 'string',
    default: 'clear-application-commands',
    description: 'Guild slash-command name.'
  },
  allowedRoleIDs: {
    type: 'string[]',
    default: [],
    description: 'Discord roles permitted to manage application commands.'
  },
  allowAdministrator: {
    type: 'boolean',
    default: true,
    description: 'Permit members with Discord Administrator permission.'
  }
} as const;

const connectors = {
  discord: {
    type: 'discord',
    description: 'Discord bot whose application commands are managed.'
  }
} as const;

type DiscordOperationsContext = PluginContext<
  {
    readonly guildID: string;
    readonly commandName: string;
    readonly allowedRoleIDs: readonly string[];
    readonly allowAdministrator: boolean;
  },
  typeof connectors
>;

export default definePlugin({
  apiVersion: 1,
  name: 'discordOperations',
  description:
    'Lists or removes bot application commands under configured administrator permissions.',
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
          type: ApplicationCommandType.ChatInput as const,
          options: [
            {
              name: 'name',
              description: 'Exact command name to remove; omit to list registered commands.',
              type: ApplicationCommandOptionType.String as const,
              required: false
            },
            {
              name: 'all',
              description: 'Remove every command in the explicitly selected scope.',
              type: ApplicationCommandOptionType.Boolean as const,
              required: false
            },
            {
              name: 'scope',
              description: 'Limit listing or deletion to guild or global bot commands.',
              type: ApplicationCommandOptionType.String as const,
              required: false,
              choices: [
                { name: 'This Discord server', value: 'guild' },
                { name: 'Every server using this bot', value: 'global' }
              ]
            }
          ],
          ...(context.options.allowAdministrator && context.options.allowedRoleIDs.length === 0
            ? { defaultMemberPermissions: PermissionFlagsBits.Administrator }
            : {})
        };
        const command = existing
          ? await guild.commands.edit(existing.id, commandData)
          : await guild.commands.create(commandData);

        interactionListener = (interaction) => {
          if (!interaction.isChatInputCommand() || interaction.commandId !== command.id) return;
          context.track(handleInteraction(context, discord!, guild, interaction));
        };
        discord.on('interactionCreate', interactionListener);
        context.logger.info('Mounted', {
          event: 'discord_operations_mounted',
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
  context: DiscordOperationsContext,
  discord: Client,
  guild: Guild,
  interaction: ChatInputCommandInteraction
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
      content: 'You are not authorized to manage application commands.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  try {
    const name = interaction.options.getString('name')?.trim();
    const clearAll = interaction.options.getBoolean('all') ?? false;
    const scope = interaction.options.getString('scope') as CommandScope | null;
    if (name && clearAll) {
      await interaction.reply({
        content: 'Choose either an exact command name or all:true, not both.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (clearAll && !scope) {
      await interaction.reply({
        content: 'Bulk removal requires an explicit scope:guild or scope:global choice.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const application = discord.application;
    if (!application) throw new Error('Discord application is not ready');
    const [guildCommands, globalCommands] = await Promise.all([
      guild.commands.fetch(),
      application.commands.fetch()
    ]);
    if (!name && !clearAll) {
      await interaction.reply({
        content: formatCommandLists(guildCommands.values(), globalCommands.values(), scope),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (clearAll) {
      const commands = scope === 'guild' ? guildCommands : globalCommands;
      const removedNames = [...commands.values()].map((command) => command.name);
      if (scope === 'guild') await guild.commands.set([]);
      else await application.commands.set([]);
      await interaction.editReply(
        removedNames.length === 0
          ? `No ${scope} application commands were registered.`
          : `Removed ${removedNames.length} ${scope} application command(s): ${summarizeNames(
              removedNames,
              1400
            )}\nRestart active command plugins to register their current commands again.${
              scope === 'global'
                ? ' Discord may take time to propagate global command changes.'
                : ''
            }`
      );
      context.logger.warn('Cleared application commands', {
        event: 'discord_application_commands_cleared',
        outcome: 'success',
        userID: interaction.user.id,
        guildID: interaction.guildId,
        scope,
        commandNames: removedNames
      });
      return;
    }

    const requestedScopes: readonly CommandScope[] = scope ? [scope] : ['guild', 'global'];
    const matches = requestedScopes.flatMap((candidateScope) => {
      const commands = candidateScope === 'guild' ? guildCommands : globalCommands;
      return [...commands.values()]
        .filter((command) => command.name.toLowerCase() === name!.toLowerCase())
        .map((command) => ({ scope: candidateScope, command }));
    });
    if (matches.length === 0) {
      await interaction.editReply(
        `No${scope ? ` ${scope}` : ''} application command named ${inlineCode(name!)} exists.`
      );
      return;
    }
    if (!scope && new Set(matches.map((match) => match.scope)).size > 1) {
      await interaction.editReply(
        `${inlineCode(name!)} exists in both guild and global scope. Run the command again with an explicit scope.`
      );
      return;
    }
    for (const match of matches) {
      if (match.scope === 'guild') await guild.commands.delete(match.command.id);
      else await application.commands.delete(match.command.id);
    }
    const removedScope = matches[0]!.scope;
    await interaction.editReply(
      `Removed ${removedScope} application command ${inlineCode(name!)}. If it belongs to an active plugin, that plugin may recreate it on restart.`
    );
    context.logger.warn('Removed application command', {
      event: 'discord_application_command_removed',
      outcome: 'success',
      userID: interaction.user.id,
      guildID: interaction.guildId,
      scope: removedScope,
      commandName: name,
      commandIDs: matches.map((match) => match.command.id)
    });
  } catch (error) {
    context.logger.error('Could not manage application commands', {
      event: 'discord_application_command_cleanup',
      outcome: 'failure',
      userID: interaction.user.id,
      guildID: interaction.guildId,
      error: error instanceof Error ? error.message : String(error)
    });
    const content = 'Could not manage application commands. Check the SquadXO console.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content);
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

function validateOptions(context: DiscordOperationsContext): void {
  if (!context.options.guildID) throw new Error('guildID must be a non-empty Discord guild ID');
  if (!/^[a-z0-9_-]{1,32}$/.test(context.options.commandName)) {
    throw new Error(
      'commandName must contain 1-32 lowercase letters, numbers, hyphens, or underscores'
    );
  }
  if (!context.options.allowAdministrator && context.options.allowedRoleIDs.length === 0) {
    throw new Error('At least one allowedRoleID is required when allowAdministrator is false');
  }
}

function authorized(
  context: DiscordOperationsContext,
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

function formatCommandLists(
  guildCommands: Iterable<{ readonly name: string }>,
  globalCommands: Iterable<{ readonly name: string }>,
  scope: CommandScope | null
): string {
  const guildNames = [...guildCommands].map((command) => command.name).sort();
  const globalNames = [...globalCommands].map((command) => command.name).sort();
  const sections = scope
    ? [formatScope(scope, scope === 'guild' ? guildNames : globalNames, 1500)]
    : [formatScope('guild', guildNames, 750), formatScope('global', globalNames, 750)];
  return `${sections.join('\n')}\nUse name:<command> to remove one. Bulk removal requires all:true and an explicit scope.`;
}

function formatScope(scope: CommandScope, names: readonly string[], limit: number): string {
  return names.length === 0
    ? `${scopeLabel(scope)} commands: none`
    : `${scopeLabel(scope)} commands (${names.length}): ${summarizeNames(names, limit)}`;
}

function scopeLabel(scope: CommandScope): string {
  return scope === 'guild' ? 'Guild' : 'Global';
}

function summarizeNames(names: readonly string[], limit: number): string {
  let result = '';
  for (const name of names) {
    const candidate = result ? `${result}, ${inlineCode(name)}` : inlineCode(name);
    if (candidate.length > limit) return `${result}, ...`;
    result = candidate;
  }
  return result;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll('`', '')}\``;
}
