import DiscordBasePlugin from './discord-base-plugin.js';

const BUTTON_IDS = new Set(['completed', 'silent-close', 'toggle-claim']);
const ATTRIBUTION = `Made by JetDave, modified by Unn.\nCopyright © ${new Date().getFullYear()}`;

function escapeMarkdownLinkText(value) {
  return String(value).replace(/[\\[\]]/g, '\\$&');
}

function identifierWithName(identifier, name, fallback) {
  const value = identifier ?? fallback;
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  return normalizedName ? `${value} (${normalizedName})` : String(value);
}

export default class unnAdminRequest extends DiscordBasePlugin {
  static get description() {
    return (
      'Creates a Discord thread when a player requests an admin and relays messages between ' +
      'in-game chat and Discord until the request is closed.'
    );
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The Discord channel in which admin requests are created.',
        default: '',
        example: '667741905228136459'
      },
      ignoreChats: {
        required: false,
        description: 'Chat channels from which admin requests should be ignored.',
        default: [],
        example: ['ChatSquad']
      },
      ignorePhrases: {
        required: false,
        description: 'Request phrases that should be ignored.',
        default: [],
        example: ['switch']
      },
      command: {
        required: false,
        description: 'The in-game chat command that creates an admin request.',
        default: 'admin'
      },
      pingGroups: {
        required: false,
        description: 'Discord role IDs or names to mention when the ping cooldown permits.',
        default: [],
        example: ['500455137626554379']
      },
      pingDelay: {
        required: false,
        description: 'Cooldown between Discord role mentions in milliseconds.',
        default: 60_000
      },
      color: {
        required: false,
        description: 'The color of the request embed.',
        default: 16_761_867
      },
      warnInGameAdmins: {
        required: false,
        description: 'Relay a new request directly to connected in-game admins.',
        default: false
      },
      showInGameAdmins: {
        required: false,
        description: 'Tell the requester how many in-game admins are connected.',
        default: true
      },
      autocloseAfterMinutes: {
        required: false,
        description: 'Close an unresolved request after this many minutes.',
        default: 10
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.lastPing = Date.now() - this.options.pingDelay;
    this.requestsByPlayer = new Map();
    this.requestsByThread = new Map();
    this.requestsByMessage = new Map();

    this.onChatCommand = this.onChatCommand.bind(this);
    this.onChatMessage = this.onChatMessage.bind(this);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
    this.closeAllOpenRequests = this.closeAllOpenRequests.bind(this);
    this.onDiscordInteraction = this.onDiscordInteraction.bind(this);
    this.onDiscordMessage = this.onDiscordMessage.bind(this);
  }

  async mount() {
    this.server.on(`CHAT_COMMAND:${this.options.command}`, this.onChatCommand);
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.on('ROUND_ENDED', this.closeAllOpenRequests);
    this.options.discordClient.on('interactionCreate', this.onDiscordInteraction);
    this.options.discordClient.on('messageCreate', this.onDiscordMessage);
  }

  async unmount() {
    this.server.removeEventListener(`CHAT_COMMAND:${this.options.command}`, this.onChatCommand);
    this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
    this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.removeEventListener('ROUND_ENDED', this.closeAllOpenRequests);
    this.options.discordClient.removeListener('interactionCreate', this.onDiscordInteraction);
    this.options.discordClient.removeListener('messageCreate', this.onDiscordMessage);
    for (const request of this.requestsByPlayer.values()) clearTimeout(request.closeTimer);
    this.requestsByPlayer.clear();
    this.requestsByThread.clear();
    this.requestsByMessage.clear();
  }

  async onChatCommand(info) {
    if (this.options.ignoreChats.includes(info.chat)) return;
    if (this.options.ignorePhrases.some((phrase) => info.message.includes(phrase))) return;

    const playerID = this.playerID(info.player);
    if (!info.message.length) {
      await this.server.rcon.warn(
        playerID,
        'Please specify what you would like help with when requesting an admin.'
      );
      return;
    }
    const existingRequest = this.requestsByPlayer.get(playerID);
    if (existingRequest) return;
    if (!this.channel?.isTextBased?.()) throw new Error('Admin request channel is not text based');

    const adminIDs = await this.server.getAdminsWithPermission('canseeadminchat', 'eosID');
    const onlineAdmins = this.server.players.filter((player) => adminIDs.includes(player.eosID));
    if (this.options.warnInGameAdmins) {
      for (const admin of onlineAdmins) {
        await this.server.rcon.warn(admin.eosID, `[${info.player.name}] - ${info.message}`);
      }
    }

    const sent = await this.channel.send(this.requestMessage(info, onlineAdmins));
    let thread;
    try {
      thread = await sent.startThread({
        name: this.threadName(info.player.name),
        autoArchiveDuration: 60,
        reason: 'SquadJS admin request'
      });
    } catch (error) {
      const embed = this.baseEmbed(sent);
      embed.color = 0xff0000;
      embed.fields = [
        ...(embed.fields ?? []),
        {
          name: 'Thread Creation Failed',
          value: 'Discord could not create a thread for this request. The player can try again.'
        }
      ];
      try {
        await sent.edit({ embeds: [embed], components: [] });
      } catch (editError) {
        this.verbose(1, 'Failed to mark admin request thread creation failure', editError);
      }
      throw error;
    }
    const request = {
      playerID,
      playerName: info.player.name,
      thread,
      message: sent,
      claimedBy: null,
      closeTimer: undefined
    };
    const configuredTimeoutMinutes = Number(this.options.autocloseAfterMinutes);
    const timeoutMinutes = Number.isFinite(configuredTimeoutMinutes) && configuredTimeoutMinutes > 0
      ? configuredTimeoutMinutes
      : 10;
    request.closeTimer = setTimeout(() => {
      void this.closeRequest(
        request,
        `Request not completed within ${timeoutMinutes} minutes`,
        0xff0000
      ).catch((error) => this.verbose(1, 'Failed to automatically close admin request', error));
    }, timeoutMinutes * 60_000);
    this.requestsByPlayer.set(playerID, request);
    this.requestsByThread.set(thread.id, request);
    this.requestsByMessage.set(sent.id, request);

    await this.warnRequester(playerID, onlineAdmins.length);
  }

  async onChatMessage(info) {
    const playerID = this.playerID(info.player);
    const adminIDs = await this.server.getAdminsWithPermission('canseeadminchat', 'eosID');
    const isAdmin = adminIDs.includes(info.player.eosID);
    const requests = isAdmin
      ? [...this.requestsByPlayer.values()]
      : [this.requestsByPlayer.get(playerID)].filter(Boolean);
    for (const request of requests) {
      await request.thread.send({
        embeds: [
          {
            description: `**[${info.chat}] ${isAdmin ? '[ADMIN] ' : ''}${info.player.name}:** ${info.message}`,
            color: this.chatColor(info.chat)
          }
        ]
      });
    }
  }

  async onDiscordMessage(message) {
    if (message.author?.bot) return;
    const request = this.requestsByThread.get(message.channelId);
    if (!request) return;
    const attachmentURLs = [...message.attachments.values()].map((attachment) => attachment.url);
    const content = [message.content, ...attachmentURLs].filter(Boolean).join(' ');
    if (!content) return;
    const name = message.member?.displayName ?? message.author?.username ?? 'Discord admin';
    await this.server.rcon.warn(request.playerID, `[ADMIN] ${name}: ${content}`);
  }

  async onDiscordInteraction(interaction) {
    if (!interaction.isButton?.() || !BUTTON_IDS.has(interaction.customId)) return;
    const request = this.requestsByMessage.get(interaction.message.id);
    if (!request) return;
    const actorID = interaction.user.id;

    if (interaction.customId === 'toggle-claim') {
      if (request.claimedBy && request.claimedBy !== actorID) {
        await interaction.reply({
          content: `This request is currently claimed by <@${request.claimedBy}>.`,
          ephemeral: true
        });
        return;
      }
      const releasing = request.claimedBy === actorID;
      request.claimedBy = releasing ? null : actorID;
      await interaction.update(this.updatedRequestMessage(request, releasing));
      await request.thread.send({
        embeds: [
          {
            description: `<@${actorID}> has ${releasing ? 'released' : 'claimed'} this admin request.`,
            color: releasing ? 0x888800 : 0xffff00
          }
        ]
      });
      return;
    }

    const completed = interaction.customId === 'completed';
    await interaction.update(this.closedRequestMessage(request, actorID, completed));
    if (completed) {
      await this.server.rcon.warn(request.playerID, 'Your admin request has been marked completed.');
    }
    await this.closeRequest(
      request,
      `<@${actorID}> ${completed ? 'marked this admin request completed' : 'silently closed this admin request'}.`,
      0x66ff66,
      false
    );
  }

  async onPlayerDisconnected(info) {
    const request = this.requestsByPlayer.get(this.playerID(info.player));
    if (!request) return;
    await this.closeRequest(
      request,
      `${info.player.name} disconnected before the request was resolved.`,
      0xff0000
    );
  }

  async closeAllOpenRequests() {
    for (const request of [...this.requestsByPlayer.values()]) {
      await this.closeRequest(
        request,
        'The match ended before the request was resolved.',
        0xff4400
      );
    }
  }

  async closeRequest(request, reason, color, editMessage = true) {
    if (this.requestsByPlayer.get(request.playerID) !== request) return;
    this.forgetRequest(request);
    if (editMessage) {
      const embed = this.baseEmbed(request.message);
      embed.color = color;
      embed.fields = [
        ...(embed.fields ?? []),
        { name: 'Automatically Closed', value: reason.slice(0, 1024) }
      ];
      await request.message.edit({ embeds: [embed], components: [] });
    }
    await request.thread.send({ embeds: [{ description: reason, color }] });
    await request.thread.setArchived(true, 'SquadJS admin request closed');
  }

  forgetRequest(request) {
    clearTimeout(request.closeTimer);
    this.requestsByPlayer.delete(request.playerID);
    this.requestsByThread.delete(request.thread.id);
    this.requestsByMessage.delete(request.message.id);
  }

  requestMessage(info, onlineAdmins) {
    const battleMetricsURL =
      `https://www.battlemetrics.com/rcon/players?filter[search]=` +
      `${encodeURIComponent(info.player.eosID)}&method=quick&redirect=1`;
    const fields = [
      {
        name: 'Player',
        value: `[${escapeMarkdownLinkText(info.player.name)}](${battleMetricsURL})`,
        inline: true
      }
    ];
    fields.push(
      {
        name: 'Team & Squad',
        value: this.teamAndSquad(info.player)
      },
      { name: 'Message', value: info.message.slice(0, 1024) },
      {
        name: `Admins Online: ${onlineAdmins.length}`,
        value: this.adminList(onlineAdmins)
      }
    );
    const message = {
      embeds: [
        {
          title: `${info.player.name} has requested admin support!`,
          color: this.options.color,
          fields,
          timestamp: info.time.toISOString(),
          footer: { text: ATTRIBUTION }
        }
      ],
      components: [
        {
          type: 1,
          components: [
            { type: 2, label: 'Mark Completed', style: 3, custom_id: 'completed' },
            { type: 2, label: 'Claim', style: 1, custom_id: 'toggle-claim' },
            { type: 2, label: 'Silently Close', style: 4, custom_id: 'silent-close' }
          ]
        }
      ]
    };
    if (this.options.pingGroups.length && Date.now() - this.lastPing >= this.options.pingDelay) {
      message.content = this.options.pingGroups
        .map((group) => (/^\d+$/.test(group) ? `<@&${group}>` : `@${group}`))
        .join(' ');
      this.lastPing = Date.now();
    }
    return message;
  }

  updatedRequestMessage(request, releasing) {
    const embed = this.baseEmbed(request.message);
    embed.fields = (embed.fields ?? []).filter((field) => field.name !== 'Claimed by');
    if (!releasing) embed.fields.push({ name: 'Claimed by', value: `<@${request.claimedBy}>` });
    embed.color = releasing ? this.options.color : 0xffff00;
    const components = request.message.components.map((row) => row.toJSON());
    const claimButton = components[0]?.components?.find(
      (component) => component.custom_id === 'toggle-claim'
    );
    if (claimButton) claimButton.label = releasing ? 'Claim' : 'Release';
    return { embeds: [embed], components };
  }

  closedRequestMessage(request, actorID, completed) {
    const embed = this.baseEmbed(request.message);
    embed.color = 0x66ff66;
    embed.fields = [
      ...(embed.fields ?? []),
      {
        name: completed ? 'Marked as Completed by' : 'Silently Closed by',
        value: `<@${actorID}>`
      }
    ];
    return { embeds: [embed], components: [] };
  }

  baseEmbed(message) {
    return message.embeds[0]?.toJSON?.() ?? { ...message.embeds[0]?.data };
  }

  async warnRequester(playerID, adminCount) {
    if (!this.options.showInGameAdmins) {
      await this.server.rcon.warn(
        playerID,
        'An admin has been notified. Please wait for us to get back to you.'
      );
    } else if (adminCount === 0) {
      await this.server.rcon.warn(
        playerID,
        'There are no in-game admins, but an admin has been notified through Discord.'
      );
    } else {
      await this.server.rcon.warn(
        playerID,
        `There ${adminCount === 1 ? 'is' : 'are'} ${adminCount} in-game admin${
          adminCount === 1 ? '' : 's'
        }. Please wait for a response.`
      );
    }
  }

  playerID(player) {
    return player.eosID ?? player.steamID;
  }

  teamAndSquad(player) {
    const squads = Array.isArray(this.server.squads) ? this.server.squads : [];
    const squad = squads.find(
      (entry) => entry.teamID === player.teamID && entry.squadID === player.squadID
    );
    return (
      `Team: ${identifierWithName(player.teamID, this.teamFaction(player.teamID, player), 'Unknown')}, ` +
      `Squad: ${identifierWithName(player.squadID, squad?.squadName, 'Unassigned')}`
    );
  }

  adminList(admins) {
    const players = Array.isArray(this.server.players) ? this.server.players : [];
    const teamIDs = new Set([1, 2]);
    for (const player of players) {
      if (player.teamID != null) teamIDs.add(player.teamID);
    }
    const groups = new Map();
    for (const teamID of [...teamIDs].sort((left, right) => left - right)) {
      const faction = this.teamFaction(teamID);
      groups.set(teamID, {
        name: faction ? `Team ${teamID} (${faction})` : `Team ${teamID}`,
        admins: []
      });
    }
    for (const admin of admins) {
      const key = admin.teamID ?? 'unknown';
      const group = groups.get(key) ?? {
        name: admin.teamID == null ? 'Unknown Team' : `Team ${admin.teamID}`,
        admins: []
      };
      group.admins.push(admin.name);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map(
        (group) =>
          `${group.name}\n${group.admins.map((name) => `- ${name}`).join('\n') || '- None'}`
      )
      .join('\n');
  }

  teamFaction(teamID, preferredPlayer) {
    const players = Array.isArray(this.server.players) ? this.server.players : [];
    const candidates = [preferredPlayer, ...players].filter(
      (player) => player?.teamID === teamID && typeof player.role === 'string'
    );
    for (const player of candidates) {
      const faction = player.role.split('_')[0]?.trim();
      if (faction) return faction;
    }
    const currentLayer = this.server.currentLayer;
    const directFaction = currentLayer?.[`team${teamID}Faction`];
    const layerFaction = currentLayer?.teams?.[teamID - 1]?.faction;
    return [directFaction, layerFaction].find(
      (faction) => typeof faction === 'string' && /^[A-Z0-9]{2,8}$/.test(faction)
    );
  }

  threadName(playerName) {
    return `Admin request - ${playerName}`.replace(/[\r\n]/g, ' ').slice(0, 100);
  }

  chatColor(chat) {
    return (
      {
        ChatAll: 0x2255ff,
        ChatTeam: 0x00aaff,
        ChatSquad: 0x00ff00,
        ChatAdmin: 0xbbffff
      }[chat] ?? 0xffcc00
    );
  }
}
