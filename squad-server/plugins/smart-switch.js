import { readSwitchRoster, switchGroups, moveToTeam } from '../utils/team-switch.js';
import DiscordBasePlugin from './discord-base-plugin.js';
import Sequelize from 'sequelize';

const { DataTypes } = Sequelize;

export default class SmartSwitch extends DiscordBasePlugin {
  static get description() {
    return 'Switch + Smart Squad Balancer combined plugin.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      commandPrefix: {
        required: false,
        description: 'Prefix of every switch command, can be an array',
        default: ['!switch', '!change']
      },
      doubleSwitchCommands: {
        required: false,
        description: 'Array of commands that can be sent in every chat to request a double switch',
        default: [],
        example: ['!bug', '!stuck', '!doubleswitch']
      },
      doubleSwitchCooldownHours: {
        required: false,
        description: 'Hours to wait before using again one of the double switch commands',
        default: 0.5
      },
      doubleSwitchDelaySeconds: {
        required: false,
        description: 'Delay between the first and second team switch',
        default: 1
      },
      endMatchSwitchSlots: {
        required: false,
        description:
          'Number of switch slots, players will be put in a queue and switched at the end of the match',
        default: 3
      },
      switchCooldownHours: {
        required: false,
        description: 'Hours to wait before using again the !switch command',
        default: 3
      },
      switchEnabledMinutes: {
        required: false,
        description:
          'Time in minutes in which the switch will be enabled after match start or player join',
        default: 5
      },
      doubleSwitchEnabledMinutes: {
        required: false,
        description:
          'Time in minutes in which the switch will be enabled after match start or player join',
        default: 5
      },
      maxUnbalancedSlots: {
        required: false,
        description: 'Number of player of difference between the two teams to allow a team switch',
        default: 3
      },
      switchToOldTeamAfterRejoin: {
        required: false,
        description:
          'The team of a disconnecting player will be stored and after a new connection, the player will be switched to his old team',
        default: false
      },
      database: {
        required: true,
        connector: 'sequelize',
        description:
          'The Sequelize connector used by DBLog. Select the same durable primary connector alias as DBLog because SmartSwitch reads DBLog match, death, wound, and revive history in addition to storing its own state.',
        default: 'mysql'
      },
      memberPrefix: {
        required: false,
        description: 'The prefix to decide who is a member or not.',
        default: ''
      },
      channelID: {
        required: true,
        description: 'The ID of the Discord channel to log squad balancing events to.',
        default: '',
        example: '667741905228136459'
      },
      color: {
        required: false,
        description: 'The color of the embed for Discord logging.',
        default: 16761867
      },
      testMode: {
        required: false,
        description:
          'When enabled, performs database validation but skips any actual team balancing actions.',
        default: false
      },
      consecutiveWinsThreshold: {
        required: false,
        description: 'Number of consecutive round wins before triggering reshuffle.',
        default: 3
      },
      shuffleDelaySeconds: {
        required: false,
        description: 'Delay in seconds after round end before performing the reshuffle.',
        default: 15
      },
      recentShuffleClearMinutes: {
        required: false,
        description: 'Minutes after a shuffle to clear the recent shuffle switch lockout.',
        default: 15
      },
      showBroadcasts: {
        required: false,
        description: 'Whether to broadcast messages about the reshuffling action.',
        default: true
      },
      considerTicketDifference: {
        required: false,
        description: 'Whether to require a minimum ticket difference to count a round win.',
        default: false
      },
      ticketDifferenceThreshold: {
        required: false,
        description: 'Ticket difference threshold for non-invasion layers to count as a valid win.',
        default: 200
      },
      invasionTicketDifferenceThreshold: {
        required: false,
        description: 'Ticket difference threshold for invasion layers to count as a valid win.',
        default: 700
      },
      excludedLayers: {
        required: false,
        description: 'An array of layer identifiers to exclude (case insensitive).',
        default: ['seed', 'jensen']
      },
      killWeight: {
        required: false,
        description: 'Weight factor for kills in performance calculation.',
        default: 1
      },
      reviveWeight: {
        required: false,
        description: 'Weight factor for revives in performance calculation.',
        default: 1
      },
      teamkillWeight: {
        required: false,
        description:
          'Weight factor for teamkills in performance calculation (negative value reduces score).',
        default: -2
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.playersConnectionTime = new Map();
    this.matchEndSwitch = new Array(
      this.options.endMatchSwitchSlots > 0 ? this.options.endMatchSwitchSlots : 0
    );
    this.recentSwitches = [];
    this.recentDoubleSwitches = [];
    this.recentDisconnections = new Map();
    this.recentShuffle = false;
    this.recentShuffleTimeout = null;
    this.rejoinTimeouts = new Set();
    this.pendingDelays = new Map();
    this.active = false;
    this.roundEndOperation = null;
    this.switchOperation = Promise.resolve();
    this.shufflePlan = null;
    this.pendingBalanceMove = null;

    this.queuedSquads = [];
    this.queuedShuffle = false;

    this.consecutiveWins = 0;
    this.lastWinnerTeam = null;
    this.swappedPlayers = new Set();
    this.currentMatchId = null;
    this.teamStats = {
      team1: { tickets: 0, kills: 0, wounds: 0, teamkills: 0, revives: 0 },
      team2: { tickets: 0, kills: 0, wounds: 0, teamkills: 0, revives: 0 }
    };

    this.models = {};
    this.createModel('Endmatch', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      name: {
        type: DataTypes.STRING
      },
      steamID: {
        type: DataTypes.STRING
      },
      eosID: {
        type: DataTypes.STRING
      },
      targetTeamID: { type: DataTypes.INTEGER, allowNull: true },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      }
    });

    this.broadcast = (msg) => {
      return this.server.rcon.broadcast(msg);
    };
    this.warn = (playerID, msg) => {
      return this.server.rcon.warn(playerID, msg);
    };

    this.onChatMessage = this.onChatMessage.bind(this);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onRoundEnded = this.onRoundEnded.bind(this);
  }

  scheduleRecentShuffleClear() {
    this.recentShuffle = true;
    if (this.recentShuffleTimeout) clearTimeout(this.recentShuffleTimeout);
    const delayMs = this.options.recentShuffleClearMinutes * 60 * 1000;
    this.recentShuffleTimeout = setTimeout(() => {
      this.recentShuffle = false;
      this.recentShuffleTimeout = null;
    }, delayMs);
  }

  clearRecentShuffle() {
    this.recentShuffle = false;
    if (this.recentShuffleTimeout) {
      clearTimeout(this.recentShuffleTimeout);
      this.recentShuffleTimeout = null;
    }
  }

  createModel(name, schema) {
    this.models[name] = this.options.database.define(`SmartSwitch_${name}`, schema, {
      timestamps: false
    });
  }

  dbLogTable(name) {
    const database = this.options.database;
    const queryGenerator = database.getQueryInterface().queryGenerator;
    const configuredSchema =
      database.getDialect() === 'postgres' && typeof database.options?.schema === 'string'
        ? database.options.schema
        : null;
    return queryGenerator.quoteTable(
      configuredSchema ? { tableName: name, schema: configuredSchema } : name
    );
  }

  dbLogColumn(name) {
    return this.options.database.getQueryInterface().queryGenerator.quoteIdentifier(name);
  }

  async prepareToMount() {
    await super.prepareToMount();
    await this.models.Endmatch.sync();
    const table = this.models.Endmatch.getTableName();
    const columns = await this.options.database.getQueryInterface().describeTable(table);
    if (!columns.eosID) {
      await this.options.database.getQueryInterface().addColumn(table, 'eosID', {
        type: DataTypes.STRING,
        allowNull: true
      });
    }
    if (!columns.targetTeamID) {
      await this.options.database.getQueryInterface().addColumn(table, 'targetTeamID', {
        type: DataTypes.INTEGER,
        allowNull: true
      });
    }
  }

  async mount() {
    try {
      await this.options.database.query('SELECT 1', {
        type: Sequelize.QueryTypes.SELECT
      });
      if (this.options.testMode) {
        await this.verifyDatabaseStructure();
      }
    } catch (error) {
      this.verbose(1, `Database connection error: ${error.message}. Disabling SmartSwitch.`);
      return;
    }

    this.server.on('CHAT_MESSAGE', this.onChatMessage);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('ROUND_ENDED', this.onRoundEnded);
    this.active = true;
  }

  async unmount() {
    this.active = false;
    this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
    this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeEventListener('ROUND_ENDED', this.onRoundEnded);
    this.clearRecentShuffle();
    for (const timeout of this.rejoinTimeouts) clearTimeout(timeout);
    this.rejoinTimeouts.clear();
    for (const [timeout, resolve] of this.pendingDelays) {
      clearTimeout(timeout);
      resolve(false);
    }
    this.pendingDelays.clear();
    if (this.roundEndOperation) await this.roundEndOperation.catch(() => {});
  }

  getPlayerIdentifier(player) {
    return player?.eosID || player?.steamID || null;
  }

  getStoredIdentifier(player) {
    return player?.eosID || player?.steamID || null;
  }

  wait(delayMs) {
    if (!this.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingDelays.delete(timeout);
        resolve(this.active);
      }, delayMs);
      this.pendingDelays.set(timeout, resolve);
    });
  }

  async onChatMessage(info) {
    const playerID = this.getPlayerIdentifier(info.player);
    const playerName = info.player?.name;
    const message = info.message.toLowerCase();

    if (this.options.doubleSwitchCommands.find((c) => c.toLowerCase() == message)) {
      await this.doubleSwitchPlayer(playerID);
    }

    const commandPrefixes =
      typeof this.options.commandPrefix === 'string'
        ? [this.options.commandPrefix]
        : this.options.commandPrefix;
    const commandPrefixInUse = commandPrefixes.find((prefix) => {
      const normalizedPrefix = prefix.toLowerCase();
      const remainder = message.slice(normalizedPrefix.length);
      return (
        message.startsWith(normalizedPrefix) &&
        (message === normalizedPrefix || /^\s/.test(remainder))
      );
    });

    if (!commandPrefixInUse) return;

    this.verbose(
      1,
      `${playerName}:\n > Connection: ${this.getSecondsFromJoin(playerID)}\n > Match Start: ${this.getSecondsFromMatchStart()}`
    );
    this.verbose(1, 'Received command', message, commandPrefixInUse);

    const commandSplit = message.substring(commandPrefixInUse.length).trim().split(' ');
    const subCommand = commandSplit[0];
    const isAdmin = info.chat === 'ChatAdmin';

    if (subCommand && subCommand != '') {
      if (!isAdmin) return;
      let pl;
      switch (subCommand) {
        case 'now':
          pl = this.getPlayerByUsernameOrID(playerID, commandSplit.splice(1).join(' '));
          if (pl) await this.switchPlayer(this.getPlayerIdentifier(pl));
          break;
        case 'double':
          pl = this.getPlayerByUsernameOrID(playerID, commandSplit.splice(1).join(' '));
          if (pl) await this.doubleSwitchPlayer(this.getPlayerIdentifier(pl), true, playerID);
          break;
        case 'squad':
          await this.server.updateSquadList();
          await this.server.updatePlayerList();
          await this.switchSquad(+commandSplit[1], commandSplit[2]);
          break;
        case 'doublesquad':
          await this.server.updateSquadList();
          await this.server.updatePlayerList();
          await this.doubleSwitchSquad(+commandSplit[1], commandSplit[2]);
          break;
        case 'queue':
          await this.server.updatePlayerList();
          pl = this.getPlayerByUsernameOrID(playerID, commandSplit.splice(1).join(' '));
          if (!pl) return;
          await this.addPlayerToMatchendSwitches(pl);
          await this.warn(playerID, `Player ${pl.name} queued for match-end switch`);
          break;
        case 'queuesquad':
          await this.server.updateSquadList();
          await this.server.updatePlayerList();
          await this.addSquadToQueuedSwitches(+commandSplit[1], commandSplit[2]);
          await this.warn(
            playerID,
            `Squad ${commandSplit[1]} ${commandSplit[2]} queued for match-end switch`
          );
          break;
        case 'queueshuffle':
          this.queuedShuffle = true;
          this.consecutiveWins = 0;
          this.lastWinnerTeam = null;
          await this.warn(playerID, 'Queued smart shuffle for match end');
          break;
        case 'list': {
          const players = await this.models.Endmatch.findAll();
          const team1Squads = this.queuedSquads.filter((s) => s.teamID === 1).map((s) => s.squadID);
          const team2Squads = this.queuedSquads.filter((s) => s.teamID === 2).map((s) => s.squadID);
          const hasAnything =
            players.length || team1Squads.length || team2Squads.length || this.queuedShuffle;
          if (!hasAnything) {
            await this.warn(playerID, 'No queued switches or shuffles');
            break;
          }
          await this.warn(
            playerID,
            `Queued players: ${players.length}\n` +
              `Queued squads T1: ${team1Squads.join(', ') || 'none'}\n` +
              `Queued squads T2: ${team2Squads.join(', ') || 'none'}\n` +
              `Shuffle queued: ${this.queuedShuffle ? 'yes' : 'no'}`
          );
          break;
        }
        case 'cancel':
          await this.clearAllQueues();
          await this.warn(playerID, 'Cleared all queued switches/shuffles');
          break;
        case 'refresh':
          await this.server.updateSquadList();
          await this.server.updatePlayerList();
          await this.warn(playerID, 'Players and squads refreshed');
          break;
        case 'slots':
          await this.server.updateSquadList();
          await this.server.updatePlayerList();
          await this.warn(
            playerID,
            `Switch slots per team:\n 1) ${this.getSwitchSlotsPerTeam(1)}\n 2) ${this.getSwitchSlotsPerTeam(2)}`
          );
          break;
        case 'triggermatchend':
          await this.warn(playerID, 'SmartSwitch: Triggering matchend for testing purposes');
          await this.onRoundEnded({});
          await this.warn(playerID, 'SmartSwitch: Done');
          break;
        case 'help': {
          let msg = `${this.options.commandPrefix}\n\n now {username|steamID}\n double {username|steamID}\n queue {username|steamID}\n queuesquad {squad_number} {teamID|teamString}\n queueshuffle\n list\n cancel`;
          await this.warn(playerID, msg);
          msg = `${this.options.commandPrefix}\n\n squad {squad_number} {teamID|teamString}\n\n doublesquad {squad_number} {teamID|teamString}\n refresh\n slots\n triggermatchend`;
          await this.warn(playerID, msg);
          break;
        }
        default:
          await this.warn(playerID, `Unknown subcommand: ${subCommand}`);
          return;
      }
    } else {
      await this.server.updateSquadList();
      await this.server.updatePlayerList();
      const roster = await readSwitchRoster(this.server);
      const requester = roster.find((p) => p.eosID === playerID || p.steamID === playerID);
      if (!requester) return;
      let group;
      try {
        group = this.getRequestedPlayers(requester, roster);
      } catch (error) {
        await this.warn(requester.eosID, error.message);
        return;
      }
      const availableSwitchSlots = this.getSwitchSlotsPerTeam(requester.teamID, roster);
      this.verbose(1, playerName, 'requested a switch');
      this.verbose(1, `Team (${requester.teamID}) balance difference:`, availableSwitchSlots);

      const recentSwitch = this.recentSwitches.find((e) => e.playerID == playerID);
      const cooldownHoursLeft = (Date.now() - +recentSwitch?.datetime) / (60 * 60 * 1000);

      if (this.recentShuffle) {
        await this.warn(playerID, 'Teams were randomized recently, switching is restricted');
        return;
      }

      if (
        this.getSecondsFromJoin(playerID) / 60 > this.options.switchEnabledMinutes &&
        this.getSecondsFromMatchStart() / 60 > this.options.switchEnabledMinutes
      ) {
        await this.warn(
          playerID,
          `A switch can be requested only in the first ${this.options.doubleSwitchEnabledMinutes} mintues from match start or connection to the server`
        );
        return;
      }

      if (recentSwitch && cooldownHoursLeft < this.options.switchCooldownHours) {
        await this.warn(
          playerID,
          `You have already used a switch in the last ${this.options.switchCooldownHours} hours`
        );
        return;
      }

      if (!this.canMovePlayers(roster, group)) {
        await this.warn(
          playerID,
          group.length > 1
            ? `Not enough room to move your entire party (${group.length} players) while keeping teams balanced`
            : 'Cannot switch now. Teams would be too unbalanced'
        );
        return;
      }

      await this.movePlayers(group, requester.teamID === 1 ? 2 : 1, true);
    }
  }

  getTeamBalanceDifference(players = this.server.players) {
    return (
      players.filter((p) => p.teamID === 1).length - players.filter((p) => p.teamID === 2).length
    );
  }

  getSwitchSlotsPerTeam(teamID, players = this.server.players) {
    if (teamID !== 1 && teamID !== 2) return 0;
    const difference = this.getTeamBalanceDifference(players) * (teamID === 1 ? 1 : -1);
    return Math.max(0, Math.floor((this.options.maxUnbalancedSlots + difference) / 2));
  }

  canMovePlayers(players, group) {
    const teamID = group[0]?.teamID;
    if ((teamID !== 1 && teamID !== 2) || group.some((p) => p.teamID !== teamID)) return false;
    const difference = this.getTeamBalanceDifference(players);
    return (
      Math.abs(difference + (teamID === 1 ? -2 : 2) * group.length) <=
      this.options.maxUnbalancedSlots
    );
  }

  getRequestedPlayers(player, roster) {
    if (player.partyID == null) return [player];
    const members = roster.filter(
      (member) => member.teamID === player.teamID && member.partyID === player.partyID
    );
    const leaders = members.filter((member) => member.isLeader);
    if (leaders.length !== 1) {
      throw new Error(
        'Party leader is missing or ambiguous; refresh the roster before requesting a switch'
      );
    }
    return player.isLeader
      ? [leaders[0], ...members.filter((member) => !member.isLeader)]
      : [player];
  }

  expandParties(players, roster) {
    const members = new Map(players.map((player) => [player.eosID, player]));
    for (const player of players) {
      if (player.partyID == null) continue;
      for (const member of roster) {
        if (member.teamID === player.teamID && member.partyID === player.partyID)
          members.set(member.eosID, member);
      }
    }
    return [...members.values()];
  }

  recordSwitch(playerID, collection = this.recentSwitches) {
    const existing = collection.find((entry) => entry.playerID === playerID);
    if (existing) existing.datetime = new Date();
    else collection.push({ playerID, datetime: new Date() });
  }

  movePlayers(players, teamID, cooldown = false) {
    const operation = this.switchOperation
      .catch(() => {})
      .then(() =>
        moveToTeam(this.server, players, teamID, {
          isActive: () => this.active,
          onMoved: (player) => {
            this.swappedPlayers.add(player.eosID);
            if (cooldown) this.recordSwitch(player.eosID);
          }
        })
      );
    this.switchOperation = operation;
    return operation;
  }

  getSecondsFromJoin(playerID) {
    const connectedAt = this.playersConnectionTime.get(playerID);
    return connectedAt ? (Date.now() - +connectedAt) / 1000 : 0;
  }

  getSecondsFromMatchStart() {
    const matchStartedAt = this.server.layerHistory?.[0]?.time;
    return matchStartedAt ? (Date.now() - +matchStartedAt) / 1000 : 0;
  }

  async doubleSwitchPlayer(playerID, forced = false, senderPlayerID) {
    if (!playerID || !this.active) return;
    const roster = await readSwitchRoster(this.server);
    const player = roster.find((p) => p.eosID === playerID || p.steamID === playerID);
    if (!player) return;
    let group;
    try {
      group = this.getRequestedPlayers(player, roster);
    } catch (error) {
      await this.warn(senderPlayerID ?? player.eosID, error.message);
      return;
    }
    const recentSwitch = this.recentDoubleSwitches.find((e) => e.playerID === player.eosID);
    if (!forced) {
      if (
        this.getSecondsFromJoin(player.eosID) / 60 > this.options.doubleSwitchEnabledMinutes &&
        this.getSecondsFromMatchStart() / 60 > this.options.doubleSwitchEnabledMinutes
      ) {
        await this.warn(player.eosID, 'The double-switch request window has ended');
        return;
      }
      if (
        recentSwitch &&
        (Date.now() - +recentSwitch.datetime) / 3600000 < this.options.doubleSwitchCooldownHours
      ) {
        await this.warn(player.eosID, 'You have already requested a double switch recently');
        return;
      }
    }
    const originalTeam = player.teamID;
    const first = await this.movePlayers(group, originalTeam === 1 ? 2 : 1);
    if (!forced)
      for (const eosID of first.moved) this.recordSwitch(eosID, this.recentDoubleSwitches);
    if (!(await this.wait(this.options.doubleSwitchDelaySeconds * 1000))) return;
    await this.movePlayers(group, originalTeam);
    if (forced && senderPlayerID)
      await this.warn(senderPlayerID, 'Player has been double-switched');
  }

  async switchPlayer(playerID, targetTeamID, cooldown = false) {
    if (!playerID || !this.active)
      throw new Error('Team change stopped because the plugin is inactive');
    const roster = await readSwitchRoster(this.server);
    const player = roster.find((p) => p.eosID === playerID || p.steamID === playerID);
    if (!player) throw new Error('Player is not present in the current roster');
    const group =
      player.teamID === targetTeamID ? [player] : this.getRequestedPlayers(player, roster);
    return this.movePlayers(group, targetTeamID ?? (player.teamID === 1 ? 2 : 1), cooldown);
  }

  async switchSquad(number, team) {
    const roster = await readSwitchRoster(this.server);
    const players = this.getPlayersFromSquad(number, team, roster);
    if (!players?.length) return;
    const group = this.expandParties(players, roster);
    await this.movePlayers(group, players[0].teamID === 1 ? 2 : 1, true);
  }

  getPlayersFromSquad(number, team, roster = this.server.players) {
    let team_id = null;

    if (+team >= 0) team_id = +team;
    else team_id = this.getFactionId(team);

    if (!team_id) {
      this.verbose(1, 'Could not find a faction from:', team);
      return;
    }
    return roster.filter((p) => p.teamID == team_id && p.squadID == number);
  }

  async doubleSwitchSquad(number, team) {
    const roster = await readSwitchRoster(this.server);
    const players = this.getPlayersFromSquad(number, team, roster);
    if (!players?.length) return;
    const group = this.expandParties(players, roster);
    const originalTeam = players[0].teamID;
    await this.movePlayers(group, originalTeam === 1 ? 2 : 1, true);
    if (!(await this.wait(this.options.doubleSwitchDelaySeconds * 1000))) return;
    await this.movePlayers(group, originalTeam, true);
  }

  getFactionId(team) {
    const firstPlayer = this.server.players.find((p) =>
      p.role?.toLowerCase().startsWith(team.toLowerCase())
    );
    if (firstPlayer) return firstPlayer.teamID;

    return null;
  }

  getPlayersByUsername(username) {
    return this.server.players.filter((p) => p.name.toLowerCase().includes(username.toLowerCase()));
  }

  getPlayerByID(playerID) {
    return this.server.players.find(
      (player) => player.eosID == playerID || player.steamID == playerID
    );
  }

  getPlayerByUsernameOrID(senderPlayerID, ident) {
    let ret = null;

    ret = this.getPlayerByID(ident);
    if (ret) return ret;

    ret = this.getPlayersByUsername(ident);
    if (ret.length == 0) {
      void this.warn(senderPlayerID, `Could not find a player whose username includes: "${ident}"`);
      return;
    }
    if (ret.length > 1) {
      void this.warn(senderPlayerID, `Found multiple players whose usernames include: "${ident}"`);
      return;
    }

    return ret[0];
  }

  async onPlayerConnected(info) {
    const playerID = this.getPlayerIdentifier(info.player);
    if (!playerID) return;
    this.playersConnectionTime.set(playerID, new Date());
    await this.switchToPreDisconnectionTeam(info);
  }

  async onPlayerDisconnected(info) {
    const playerID = this.getPlayerIdentifier(info.player);
    const teamID = info.player?.teamID;

    if (!playerID) return;
    this.recentDisconnections.set(playerID, { teamID, time: new Date() });
    this.recentDoubleSwitches = this.recentDoubleSwitches.filter(
      (player) => player.playerID != playerID
    );
  }

  async switchToPreDisconnectionTeam(info) {
    if (!this.options.switchToOldTeamAfterRejoin) return;

    const playerID = this.getPlayerIdentifier(info.player);
    const teamID = info.player?.teamID;

    const preDisconnectionData = this.recentDisconnections.get(playerID);
    if (!preDisconnectionData) return;

    if (Date.now() - preDisconnectionData.time > 60 * 60 * 1000) return;

    if (
      (preDisconnectionData.teamID === 1 || preDisconnectionData.teamID === 2) &&
      teamID != preDisconnectionData.teamID
    ) {
      const timeout = setTimeout(() => {
        this.rejoinTimeouts.delete(timeout);
        void this.switchPlayer(playerID, preDisconnectionData.teamID).catch((error) =>
          this.verbose(1, `Failed to restore player team after reconnect: ${error.message}`)
        );
      }, 5000);
      this.rejoinTimeouts.add(timeout);
    }
  }

  async addPlayerToMatchendSwitches(player) {
    const playerID = this.getPlayerIdentifier(player);
    const queuedPlayers = await this.models.Endmatch.findAll();
    if (queuedPlayers.some((queuedPlayer) => this.getStoredIdentifier(queuedPlayer) == playerID)) {
      return;
    }
    await this.models.Endmatch.create({
      name: player.name,
      steamID: player.steamID,
      eosID: player.eosID
    });
  }

  async addSquadToQueuedSwitches(number, team) {
    const players = this.getPlayersFromSquad(number, team);
    if (!players) return;
    const teamID = players.length ? +players[0].teamID : null;
    if (!teamID) return;
    if (!this.queuedSquads.some((squad) => squad.teamID === teamID && squad.squadID === number)) {
      this.queuedSquads.push({ teamID, squadID: number });
    }
  }

  async clearAllQueues() {
    this.shufflePlan = null;
    this.pendingBalanceMove = null;
    this.queuedSquads = [];
    this.queuedShuffle = false;
    this.consecutiveWins = 0;
    this.lastWinnerTeam = null;
    await this.models.Endmatch.destroy({ where: {} });
  }

  async onRoundEnded(info) {
    if (this.roundEndOperation) return this.roundEndOperation;
    this.roundEndOperation = this.processRoundEnded(info).finally(() => {
      this.roundEndOperation = null;
    });
    return this.roundEndOperation;
  }

  async processRoundEnded(info) {
    if (!this.active) return;
    if (this.options.testMode) {
      await this.verifyDatabaseStructure();
      return;
    }
    try {
      const roster = await readSwitchRoster(this.server);
      this.prepareQueuedSquads(roster);
      await this.prepareQueuedPlayerTargets(roster);
      const shuffleTriggered = await this.maybeShuffleOnRoundEnd(info);
      if (shuffleTriggered) {
        await this.clearCompletedQueues(await readSwitchRoster(this.server));
        this.scheduleRecentShuffleClear();
        return;
      }
      if (this.queuedShuffle || !(await this.announceQueuedMatchEndSwitches())) return;
      const destinations = new Map();
      await this.executeQueuedPlayerSwitches(destinations);
      await this.executeQueuedSquadSwitches(destinations);
    } catch (error) {
      this.verbose(1, `Round-end switches paused; queues retained: ${error.message}`);
    }
  }

  prepareQueuedSquads(roster) {
    for (const squad of this.queuedSquads) {
      if (squad.players) continue;
      const players = roster.filter(
        (p) => p.teamID === squad.teamID && p.squadID === squad.squadID
      );
      if (players.length) {
        squad.players = this.expandParties(players, roster);
        squad.targetTeamID = squad.teamID === 1 ? 2 : 1;
      }
    }
  }

  async prepareQueuedPlayerTargets(roster) {
    const rows = await this.models.Endmatch.findAll();
    for (const row of rows) {
      if (row.targetTeamID != null) continue;
      const player = roster.find(
        (p) => p.eosID === row.eosID || (row.steamID && p.steamID === row.steamID)
      );
      if (player?.teamID === 1 || player?.teamID === 2)
        await row.update({ targetTeamID: player.teamID === 1 ? 2 : 1 });
    }
    return rows;
  }

  async clearCompletedQueues(roster) {
    for (const row of await this.models.Endmatch.findAll()) {
      const player = roster.find(
        (p) => p.eosID === row.eosID || (row.steamID && p.steamID === row.steamID)
      );
      if (player && player.teamID === row.targetTeamID) await row.destroy();
    }
    this.queuedSquads = this.queuedSquads.filter(
      (squad) =>
        !squad.players?.length ||
        !squad.players.every((member) =>
          roster.some((p) => p.eosID === member.eosID && p.teamID === squad.targetTeamID)
        )
    );
  }

  async announceQueuedMatchEndSwitches() {
    const queuedPlayers = await this.models.Endmatch.findAll();
    const queuedSquadPlayers = this.getQueuedSquadPlayers();
    if (queuedPlayers.length === 0 && queuedSquadPlayers.length === 0) return true;

    const delaySeconds = this.options.shuffleDelaySeconds;
    await this.broadcast(
      `Match-end team swaps are queued and will execute in ${delaySeconds} seconds.`
    );

    await Promise.all(
      queuedPlayers.map((player) =>
        this.warn(
          this.getStoredIdentifier(player),
          `You will be switched in ${delaySeconds} seconds`
        )
      )
    );
    await Promise.all(
      queuedSquadPlayers.map((player) =>
        this.warn(
          this.getPlayerIdentifier(player),
          `Your squad is queued for a team switch in ${delaySeconds} seconds`
        )
      )
    );

    return this.wait(delaySeconds * 1000);
  }

  getQueuedSquadPlayers() {
    const queuedPlayers = [];
    for (const squad of this.queuedSquads) {
      const squadPlayers = this.server.players.filter(
        (p) => p.teamID == squad.teamID && p.squadID == squad.squadID
      );
      queuedPlayers.push(...squadPlayers);
    }
    return queuedPlayers;
  }

  async executeQueuedPlayerSwitches(destinations = new Map()) {
    if (!this.active) return;
    const roster = await readSwitchRoster(this.server);
    const rows = await this.prepareQueuedPlayerTargets(roster);
    for (const row of rows) {
      const player = roster.find(
        (p) => p.eosID === row.eosID || (row.steamID && p.steamID === row.steamID)
      );
      if (!player || row.targetTeamID == null) continue;
      const destination = destinations.get(player.eosID) ?? row.targetTeamID;
      destinations.set(player.eosID, destination);
      try {
        await this.switchPlayer(player.eosID, destination, true);
        await row.destroy();
      } catch (error) {
        this.verbose(1, `Queued switch retained: ${error.message}`);
      }
    }
  }

  async executeQueuedSquadSwitches(destinations = new Map()) {
    if (!this.active || this.queuedSquads.length === 0) return;
    const roster = await readSwitchRoster(this.server);
    this.prepareQueuedSquads(roster);
    const remaining = [];
    for (const squad of this.queuedSquads) {
      if (!squad.players?.length) {
        remaining.push(squad);
        continue;
      }
      for (const player of squad.players) {
        if (!destinations.has(player.eosID)) destinations.set(player.eosID, squad.targetTeamID);
      }
      try {
        if (squad.players.some((player) => destinations.get(player.eosID) !== squad.targetTeamID)) {
          throw new Error('Queued destinations conflict');
        }
        await this.movePlayers(squad.players, squad.targetTeamID, true);
      } catch (error) {
        remaining.push(squad);
        this.verbose(1, `Queued squad retained: ${error.message}`);
      }
    }
    this.queuedSquads = remaining;
  }

  async maybeShuffleOnRoundEnd(info) {
    this.currentMatchId = null;
    this.teamStats = {
      team1: { tickets: 0, kills: 0, wounds: 0, teamkills: 0, revives: 0 },
      team2: { tickets: 0, kills: 0, wounds: 0, teamkills: 0, revives: 0 }
    };

    if (this.queuedShuffle) {
      const completed = await this.runSmartShuffle(info, true, 'Manual');
      if (completed) this.queuedShuffle = false;
      return completed;
    }

    let excludedLayers = [];
    if (this.options.excludedLayers && Array.isArray(this.options.excludedLayers)) {
      excludedLayers = this.options.excludedLayers.map((layer) => layer.toLowerCase());
    }

    if (
      !info.winner ||
      !info.loser ||
      (info.winner.layer &&
        excludedLayers.some((excluded) => info.winner.layer.toLowerCase().includes(excluded)))
    ) {
      this.verbose(
        1,
        'Round skipped: missing winner/loser data or round is from an excluded layer.'
      );
      this.consecutiveWins = 0;
      this.lastWinnerTeam = null;
      return false;
    }

    let ticketDifferenceStr = 'N/A';
    let ticketBanner = '';
    if (
      this.options.considerTicketDifference &&
      typeof info.winner.tickets !== 'undefined' &&
      typeof info.loser.tickets !== 'undefined'
    ) {
      const ticketDifference = info.winner.tickets - info.loser.tickets;
      const requiredTicketDiff =
        info.winner.layer && info.winner.layer.toLowerCase().includes('invasion')
          ? this.options.invasionTicketDifferenceThreshold
          : this.options.ticketDifferenceThreshold;
      if (ticketDifference < requiredTicketDiff) {
        if (this.options.showBroadcasts) {
          this.server.rcon.broadcast(
            `Round win not counted for consecutive win streak:\nTeam ${info.winner.team}'s ticket difference of ${ticketDifference} is below threshold ${requiredTicketDiff}.`
          );
        }
        this.verbose(
          1,
          `Ticket difference too low (${ticketDifference} < ${requiredTicketDiff}). Round win not counted, resetting streak.`
        );
        this.consecutiveWins = 0;
        this.lastWinnerTeam = null;
        return false;
      }
      ticketDifferenceStr = `${ticketDifference} (Threshold: ${requiredTicketDiff})`;
      ticketBanner = ` (Ticket diff: ${ticketDifference} >= ${requiredTicketDiff})`;
    }

    const currentWinTeam = parseInt(info.winner.team, 10);
    if (isNaN(currentWinTeam)) {
      this.verbose(1, 'Invalid winner team number; skipping round processing.');
      return false;
    }

    if (currentWinTeam === 1) {
      this.teamStats.team1.tickets = info.winner.tickets || 0;
      this.teamStats.team2.tickets = info.loser.tickets || 0;
    } else {
      this.teamStats.team2.tickets = info.winner.tickets || 0;
      this.teamStats.team1.tickets = info.loser.tickets || 0;
    }

    // Squad flips the player rosters between numeric team IDs after every round.
    // Therefore the same persistent side wins when the reported team alternates
    // (1 -> 2 -> 1); repeating the numeric ID means the opposing side won.
    if (this.lastWinnerTeam !== null && this.lastWinnerTeam !== currentWinTeam) {
      this.consecutiveWins++;
    } else {
      this.consecutiveWins = 1;
    }
    this.lastWinnerTeam = currentWinTeam;

    if (this.options.showBroadcasts) {
      this.server.rcon.broadcast(
        `Team ${currentWinTeam} won this round!\n${ticketBanner} (Consecutive wins: ${this.consecutiveWins})`
      );
    }

    this.verbose(
      1,
      `Updated consecutive wins: ${this.consecutiveWins} for Team ${currentWinTeam}.`
    );

    if (this.consecutiveWins < this.options.consecutiveWinsThreshold) {
      this.verbose(
        1,
        `Consecutive wins (${this.consecutiveWins}) below threshold (${this.options.consecutiveWinsThreshold}); no action taken.`
      );
      return false;
    }

    if (this.options.showBroadcasts) {
      this.server.rcon.broadcast(
        `Team ${currentWinTeam} has won consecutively ${this.consecutiveWins} times.\nReshuffling squads in ${this.options.shuffleDelaySeconds} seconds.`
      );
    }

    return this.runSmartShuffle(info, false, ticketDifferenceStr);
  }

  async runSmartShuffle(info, isManual, ticketDifferenceStr) {
    const currentWinTeam = parseInt(info.winner?.team, 10);
    if (this.options.showBroadcasts)
      await this.broadcast(`Reshuffling groups in ${this.options.shuffleDelaySeconds} seconds.`);
    if (!(await this.wait(this.options.shuffleDelaySeconds * 1000))) return false;
    const switchedSquads = { team1: [], team2: [] };
    if (!this.shufflePlan) this.swappedPlayers.clear();
    try {
      await this.randomizeSquads(switchedSquads);
      await this.autoBalanceTeams();
      this.shufflePlan = null;
      if (this.swappedPlayers.size === 0) return false;
      await this.sendReshuffleReport(
        Number.isNaN(currentWinTeam) ? null : currentWinTeam,
        ticketDifferenceStr || 'N/A',
        switchedSquads,
        info
      );
      this.consecutiveWins = 0;
      this.lastWinnerTeam = null;
      return true;
    } catch (error) {
      if (this.swappedPlayers.size > 0) this.scheduleRecentShuffleClear();
      this.verbose(1, `Shuffle stopped; pending requests retained: ${error.message}`);
      return false;
    }
  }

  async getCurrentMatchId() {
    if (this.currentMatchId) {
      this.verbose(2, `Using cached match ID: ${this.currentMatchId}`);
      return this.currentMatchId;
    }

    try {
      const table = this.dbLogTable('DBLog_Matches');
      const id = this.dbLogColumn('id');
      const server = this.dbLogColumn('server');
      const endTime = this.dbLogColumn('endTime');
      const startTime = this.dbLogColumn('startTime');
      const query = `
        SELECT ${id} AS id
        FROM ${table}
        WHERE ${server} = :serverId
        AND ${endTime} IS NULL
        ORDER BY ${startTime} DESC
        LIMIT 1
      `;

      const result = await this.options.database.query(query, {
        replacements: { serverId: this.server.id },
        type: Sequelize.QueryTypes.SELECT
      });

      this.verbose(2, `getCurrentMatchId query result: ${JSON.stringify(result)}`);

      if (result && result.length > 0) {
        this.currentMatchId = result[0].id;
        return this.currentMatchId;
      }

      return null;
    } catch (error) {
      this.verbose(1, `Error getting current match ID: ${error.message}`);
      return null;
    }
  }

  async verifyDatabaseStructure() {
    this.verbose(1, 'Testing database structure and required tables...');

    const requiredTables = ['DBLog_Matches', 'DBLog_Wounds', 'DBLog_Deaths', 'DBLog_Revives'];

    try {
      const tablesResult = await this.options.database.getQueryInterface().showAllTables();

      this.verbose(2, `Found database tables: ${JSON.stringify(tablesResult)}`);

      const tableNames = tablesResult.map((row) =>
        typeof row === 'string' ? row : row.tableName || row.table_name || row.name || ''
      );

      for (const requiredTable of requiredTables) {
        if (!tableNames.some((name) => name.toUpperCase() === requiredTable.toUpperCase())) {
          this.verbose(1, `Missing required table: ${requiredTable}`);
        } else {
          this.verbose(2, `Found required table: ${requiredTable}`);
        }
      }

      const matchId = await this.getCurrentMatchId();
      if (matchId) {
        this.verbose(1, `Successfully retrieved current match ID: ${matchId}`);
        const match = this.dbLogColumn('match');

        const woundQuery = `
          SELECT COUNT(*) as count
          FROM ${this.dbLogTable('DBLog_Wounds')}
          WHERE ${match} = :matchId
        `;

        const woundResult = await this.options.database.query(woundQuery, {
          replacements: { matchId },
          type: Sequelize.QueryTypes.SELECT
        });

        this.verbose(1, `Sample wound count for match ${matchId}: ${woundResult[0].count}`);

        const deathQuery = `
          SELECT COUNT(*) as count
          FROM ${this.dbLogTable('DBLog_Deaths')}
          WHERE ${match} = :matchId
        `;

        const deathResult = await this.options.database.query(deathQuery, {
          replacements: { matchId },
          type: Sequelize.QueryTypes.SELECT
        });

        this.verbose(1, `Sample death count for match ${matchId}: ${deathResult[0].count}`);

        const reviveQuery = `
          SELECT COUNT(*) as count
          FROM ${this.dbLogTable('DBLog_Revives')}
          WHERE ${match} = :matchId
        `;

        const reviveResult = await this.options.database.query(reviveQuery, {
          replacements: { matchId },
          type: Sequelize.QueryTypes.SELECT
        });

        this.verbose(1, `Sample revive count for match ${matchId}: ${reviveResult[0].count}`);
      } else {
        this.verbose(
          1,
          'Could not find a current match ID. Make sure a match is in progress and DBLog is capturing data.'
        );
      }

      this.verbose(1, 'Database verification complete!');
    } catch (error) {
      this.verbose(1, `Error verifying database structure: ${error.message}`);
    }
  }

  async fetchMatchDeaths(matchID) {
    try {
      const column = (name) => this.dbLogColumn(name);
      const query = `
        SELECT
          ${column('attacker')},
          ${column('attackerEOSID')},
          ${column('victim')},
          ${column('victimEOSID')},
          ${column('attackerTeamID')},
          ${column('victimTeamID')},
          ${column('teamkill')}
        FROM ${this.dbLogTable('DBLog_Deaths')}
        WHERE ${column('match')} = :matchID
      `;

      const result = await this.options.database.query(query, {
        replacements: { matchID },
        type: Sequelize.QueryTypes.SELECT
      });

      this.verbose(2, `Fetched ${result.length} deaths from match ${matchID}`);
      return result;
    } catch (error) {
      this.verbose(1, `Error fetching deaths: ${error.message}`);
      return [];
    }
  }

  async fetchMatchWounds(matchID) {
    try {
      const column = (name) => this.dbLogColumn(name);
      const query = `
        SELECT
          ${column('attacker')},
          ${column('attackerEOSID')},
          ${column('victim')},
          ${column('victimEOSID')},
          ${column('attackerTeamID')},
          ${column('victimTeamID')},
          ${column('teamkill')}
        FROM ${this.dbLogTable('DBLog_Wounds')}
        WHERE ${column('match')} = :matchID
      `;

      const result = await this.options.database.query(query, {
        replacements: { matchID },
        type: Sequelize.QueryTypes.SELECT
      });

      this.verbose(2, `Fetched ${result.length} wounds from match ${matchID}`);
      return result;
    } catch (error) {
      this.verbose(1, `Error fetching wounds: ${error.message}`);
      return [];
    }
  }

  async fetchMatchRevives(matchID) {
    try {
      const column = (name) => this.dbLogColumn(name);
      const query = `
        SELECT
          ${column('reviver')},
          ${column('reviverEOSID')},
          ${column('victim')},
          ${column('victimEOSID')},
          ${column('reviverTeamID')},
          ${column('victimTeamID')}
        FROM ${this.dbLogTable('DBLog_Revives')}
        WHERE ${column('match')} = :matchID
      `;

      const result = await this.options.database.query(query, {
        replacements: { matchID },
        type: Sequelize.QueryTypes.SELECT
      });

      this.verbose(2, `Fetched ${result.length} revives from match ${matchID}`);
      return result;
    } catch (error) {
      this.verbose(1, `Error fetching revives: ${error.message}`);
      return [];
    }
  }

  async fetchAllMatchData(matchID) {
    const deaths = await this.fetchMatchDeaths(matchID);
    const wounds = await this.fetchMatchWounds(matchID);
    const revives = await this.fetchMatchRevives(matchID);

    this.matchData = { deaths, wounds, revives };
    return this.matchData;
  }

  processTeamStats(matchData) {
    const stats = {
      team1: { kills: 0, wounds: 0, teamkills: 0, revives: 0 },
      team2: { kills: 0, wounds: 0, teamkills: 0, revives: 0 }
    };

    for (const death of matchData.deaths) {
      if (death.attackerTeamID === 1 && !death.teamkill) {
        stats.team1.kills++;
      } else if (death.attackerTeamID === 2 && !death.teamkill) {
        stats.team2.kills++;
      }
    }

    for (const wound of matchData.wounds) {
      if (wound.victimTeamID === 2 && !wound.teamkill) {
        stats.team1.wounds++;
      } else if (wound.victimTeamID === 1 && !wound.teamkill) {
        stats.team2.wounds++;
      }

      if (wound.teamkill) {
        if (wound.attackerTeamID === 1) {
          stats.team1.teamkills++;
        } else if (wound.attackerTeamID === 2) {
          stats.team2.teamkills++;
        }
      }
    }

    for (const revive of matchData.revives) {
      if (revive.reviverTeamID === 1) {
        stats.team1.revives++;
      } else if (revive.reviverTeamID === 2) {
        stats.team2.revives++;
      }
    }

    return stats;
  }

  calculateSquadScoreFromMatchData(squad, matchData) {
    if (String(squad.squadID).startsWith('unassigned-')) {
      squad.performanceScore = 0;
      squad.stats = { kills: 0, teamkills: 0, revives: 0, memberCount: squad.players.length || 1 };
      return squad;
    }

    const memberIds = new Set(
      squad.players.flatMap((player) => [player.eosID, player.steamID]).filter(Boolean)
    );
    if (memberIds.size === 0) {
      squad.performanceScore = 0;
      squad.stats = { kills: 0, teamkills: 0, revives: 0, memberCount: 0 };
      return squad;
    }

    let kills = 0;
    let teamkills = 0;
    let revives = 0;

    for (const death of matchData.deaths) {
      if (
        (memberIds.has(death.attackerEOSID) || memberIds.has(death.attacker)) &&
        !death.teamkill
      ) {
        kills++;
      }
    }

    for (const wound of matchData.wounds) {
      if ((memberIds.has(wound.attackerEOSID) || memberIds.has(wound.attacker)) && wound.teamkill) {
        teamkills++;
      }
    }

    for (const revive of matchData.revives) {
      if (memberIds.has(revive.reviverEOSID) || memberIds.has(revive.reviver)) {
        revives++;
      }
    }

    const performanceScore =
      kills * this.options.killWeight +
      revives * this.options.reviveWeight +
      teamkills * this.options.teamkillWeight;

    squad.performanceScore = performanceScore;
    squad.stats = {
      kills,
      teamkills,
      revives,
      memberCount: squad.players.length
    };

    this.verbose(
      2,
      `Squad ${squad.squadID} performance: ${performanceScore.toFixed(2)} (K:${kills}×${this.options.killWeight}/TK:${teamkills}×${this.options.teamkillWeight}/R:${revives}×${this.options.reviveWeight})`
    );

    return squad;
  }

  async calculateSquadScores(squadArray) {
    const matchID = await this.getCurrentMatchId();

    if (!matchID) {
      this.verbose(1, 'No active match found, using default squad scores');
      for (const squad of squadArray) {
        squad.performanceScore = 0;
        squad.stats = { kills: 0, teamkills: 0, revives: 0, memberCount: squad.players.length };
      }
      return;
    }

    this.verbose(1, `Using match ID: ${matchID} for squad performance calculation`);

    const matchData = await this.fetchAllMatchData(matchID);

    const teamStats = this.processTeamStats(matchData);

    this.teamStats.team1.kills = teamStats.team1.kills;
    this.teamStats.team1.wounds = teamStats.team1.wounds;
    this.teamStats.team1.teamkills = teamStats.team1.teamkills;
    this.teamStats.team1.revives = teamStats.team1.revives;

    this.teamStats.team2.kills = teamStats.team2.kills;
    this.teamStats.team2.wounds = teamStats.team2.wounds;
    this.teamStats.team2.teamkills = teamStats.team2.teamkills;
    this.teamStats.team2.revives = teamStats.team2.revives;

    this.verbose(2, `Team statistics processed: ${JSON.stringify(this.teamStats)}`);

    for (const squad of squadArray) {
      this.calculateSquadScoreFromMatchData(squad, matchData);
    }
  }

  async randomizeSquads(switchedSquads) {
    if (!this.shufflePlan) {
      const players = await readSwitchRoster(this.server);
      const groups = switchGroups(players);
      const target = Math.floor(
        Math.min(
          players.filter((p) => p.teamID === 1).length,
          players.filter((p) => p.teamID === 2).length
        ) / 2
      );
      await this.calculateSquadScores(groups);
      const plan = [];
      for (const teamID of [1, 2]) {
        const selected = groups
          .filter((group) => group.teamID === teamID)
          .sort((a, b) => (b.performanceScore || 0) - (a.performanceScore || 0));
        let selectedCount = 0;
        for (const group of selected) {
          if (selectedCount >= target) break;
          plan.push({ ...group, targetTeamID: teamID === 1 ? 2 : 1 });
          selectedCount += group.players.length;
        }
      }
      this.shufflePlan = plan;
    }
    for (const group of this.shufflePlan) {
      await this.movePlayers(group.players, group.targetTeamID, true);
      switchedSquads[`team${group.teamID}`].push(String(group.squadID));
    }
  }

  async autoBalanceTeams() {
    let players = await readSwitchRoster(this.server);
    if (this.pendingBalanceMove) {
      const pending = this.pendingBalanceMove;
      players = (await this.movePlayers(pending.players, pending.teamID, true)).players;
      this.pendingBalanceMove = null;
    }
    while (this.active) {
      const difference = this.getTeamBalanceDifference(players);
      if (Math.abs(difference) <= 1) return;
      const teamID = difference > 0 ? 1 : 2;
      const candidates = switchGroups(players.filter((p) => p.teamID === teamID))
        .filter((group) => !group.players.some((p) => this.swappedPlayers.has(p.eosID)))
        .sort((a, b) => a.players.length - b.players.length);
      // Ordinary squads may supply individuals; a party is always an indivisible group.
      candidates.push(
        ...players
          .filter(
            (p) => p.teamID === teamID && p.partyID == null && !this.swappedPlayers.has(p.eosID)
          )
          .map((p) => ({ players: [p] }))
      );
      const group = candidates.find(
        (candidate) =>
          Math.abs(difference + (teamID === 1 ? -2 : 2) * candidate.players.length) <
          Math.abs(difference)
      );
      if (!group) {
        this.verbose(
          1,
          'No whole party or eligible player can improve balance; leaving the remaining gap'
        );
        return;
      }
      this.pendingBalanceMove = { players: group.players, teamID: teamID === 1 ? 2 : 1 };
      const result = await this.movePlayers(group.players, this.pendingBalanceMove.teamID, true);
      this.pendingBalanceMove = null;
      if (result.moved.size === 0) return;
      players = result.players;
    }
  }

  async sendReshuffleReport(currentWinTeam, ticketDifferenceStr, switchedSquads) {
    const matchStats = this.teamStats;
    const winTeamLabel = currentWinTeam ? `Team ${currentWinTeam}` : 'N/A';

    const overviewEmbed = {
      title: '📊 Squad Balancer Triggered',
      color: this.options.color,
      description: this.options.considerTicketDifference
        ? `Reshuffling squads due to ${this.consecutiveWins} consecutive wins by ${winTeamLabel} with a ticket difference of ${ticketDifferenceStr}.`
        : `Reshuffling squads due to ${this.consecutiveWins} consecutive wins by ${winTeamLabel} (ticket difference not considered).`,
      fields: [
        { name: '🏆 Winning Team', value: winTeamLabel, inline: true },
        { name: '🔄 Consecutive Wins', value: this.consecutiveWins.toString(), inline: true },
        { name: '🎫 Ticket Difference', value: ticketDifferenceStr, inline: true },
        {
          name: '🔵 Team 1 Stats',
          value: `Tickets: ${matchStats.team1.tickets || 'N/A'}\nWounds: ${matchStats.team1.wounds}\nKills: ${matchStats.team1.kills}\nTKs: ${matchStats.team1.teamkills}\nRevives: ${matchStats.team1.revives}`,
          inline: true
        },
        {
          name: '🔴 Team 2 Stats',
          value: `Tickets: ${matchStats.team2.tickets || 'N/A'}\nWounds: ${matchStats.team2.wounds}\nKills: ${matchStats.team2.kills}\nTKs: ${matchStats.team2.teamkills}\nRevives: ${matchStats.team2.revives}`,
          inline: true
        }
      ],
      timestamp: new Date()
    };

    await this.sendDiscordMessage({ embed: overviewEmbed });

    const players = await this.server.rcon.getListPlayers();
    const squads = await this.server.rcon.getSquads();

    const team1PlayerCount = players.filter((p) => String(p.teamID) === '1').length;
    const team2PlayerCount = players.filter((p) => String(p.teamID) === '2').length;

    const balanceSummaryEmbed = {
      title: '⚖️ Team Balance Summary',
      color: 7506394,
      description:
        'Parties are planned together. Counts reflect the roster after verified team changes.',
      fields: [
        {
          name: '🔵 Team 1',
          value: `${team1PlayerCount} players (${switchedSquads.team2.length} squads moved from Team 2)`,
          inline: true
        },
        {
          name: '🔴 Team 2',
          value: `${team2PlayerCount} players (${switchedSquads.team1.length} squads moved from Team 1)`,
          inline: true
        }
      ]
    };

    await this.sendDiscordMessage({ embed: balanceSummaryEmbed });

    const team1Squads = {};
    const team2Squads = {};

    for (const squad of squads) {
      if (String(squad.teamID) === '1') {
        team1Squads[squad.squadID] = {
          squadID: squad.squadID,
          squadName: squad.squadName,
          players: []
        };
      } else if (String(squad.teamID) === '2') {
        team2Squads[squad.squadID] = {
          squadID: squad.squadID,
          squadName: squad.squadName,
          players: []
        };
      }
    }

    for (const player of players) {
      if (String(player.teamID) === '1' && player.squadID !== null) {
        if (!team1Squads[player.squadID]) {
          team1Squads[player.squadID] = {
            squadID: player.squadID,
            squadName: 'Unknown',
            players: []
          };
        }
        team1Squads[player.squadID].players.push(player);
      } else if (String(player.teamID) === '2' && player.squadID !== null) {
        if (!team2Squads[player.squadID]) {
          team2Squads[player.squadID] = {
            squadID: player.squadID,
            squadName: 'Unknown',
            players: []
          };
        }
        team2Squads[player.squadID].players.push(player);
      }
    }

    const switchedPlayersTeam1 = players
      .filter(
        (player) =>
          String(player.teamID) === '1' && this.swappedPlayers.has(this.getPlayerIdentifier(player))
      )
      .map((p) => p.name);

    const switchedPlayersTeam2 = players
      .filter(
        (player) =>
          String(player.teamID) === '2' && this.swappedPlayers.has(this.getPlayerIdentifier(player))
      )
      .map((p) => p.name);

    const team1Embed = {
      title: '🔵 Team 1 Squad Composition',
      color: 3447003,
      description: 'Current squad composition after balancing:',
      fields: [
        {
          name: '📊 Current Squads',
          value:
            Object.values(team1Squads)
              .map(
                (squad) =>
                  `Squad ${squad.squadID}: ${squad.squadName} (${squad.players.length} players)`
              )
              .join('\n') || 'No squads found',
          inline: false
        }
      ]
    };

    if (switchedPlayersTeam1.length > 0) {
      team1Embed.fields.push({
        name: '↔️ Players moved to this team',
        value: switchedPlayersTeam1.join(', ').substring(0, 1024) || 'None',
        inline: false
      });
    }

    const team2Embed = {
      title: '🔴 Team 2 Squad Composition',
      color: 15158332,
      description: 'Current squad composition after balancing:',
      fields: [
        {
          name: '📊 Current Squads',
          value:
            Object.values(team2Squads)
              .map(
                (squad) =>
                  `Squad ${squad.squadID}: ${squad.squadName} (${squad.players.length} players)`
              )
              .join('\n') || 'No squads found',
          inline: false
        }
      ]
    };

    if (switchedPlayersTeam2.length > 0) {
      team2Embed.fields.push({
        name: '↔️ Players moved to this team',
        value: switchedPlayersTeam2.join(', ').substring(0, 1024) || 'None',
        inline: false
      });
    }

    if (team1Embed.fields.length > 0) {
      await this.sendDiscordMessage({ embed: team1Embed });
    }
    if (team2Embed.fields.length > 0) {
      await this.sendDiscordMessage({ embed: team2Embed });
    }
  }
}
