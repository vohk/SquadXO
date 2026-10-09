import DiscordBasePlugin from './discord-base-plugin.js';

export default class SquadBaiting extends DiscordBasePlugin {
    static get description() {
        return "Squad Baiting plugin";
    }

    static get defaultEnabled() {
        return true;
    }

    static get optionsSpecification() {
        return {
            ...DiscordBasePlugin.optionsSpecification,
            channelID: {
                required: true,
                description: 'The ID of the channel to log admin broadcasts to.',
                default: '',
                example: '667741905228136459'
            },
            warnInGameAdmins: {
                required: false,
                default: true,
                description: ''
            },
            resetPlayerCountersAtNewGame: {
                required: false,
                default: true,
                description: ''
            },
            disableDefaultAdminWarns: {
                required: false,
                default: false,
                description: ''
            },
            playerRules: {
                required: false,
                default: [],
                description: 'Set of rules that will be applied on player events',
                example: [
                    {
                        name: 'Friendly and human-readable name',
                        enabled: true,
                        baitingCounter: {
                            min: 0,
                            max: 10
                        },
                        actions: [
                            {
                                type: 'rcon',
                                content: 'AdminWarn {}'
                            }
                        ]
                    }
                ]
            },
            squadRules: {
                required: false,
                default: [],
                description: 'Set of rules that will be applied on squad events',
                example: [
                    {
                        name: 'Martian-readable name',
                        enabled: true,
                        baitingCounter: {
                            min: 5,
                            max: Infinity
                        },
                        actions: [
                            {
                                type: 'rcon',
                                content: 'AdminWarn {}'
                            }
                        ]
                    }
                ]
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.onSquadCreated = this.onSquadCreated.bind(this)
        this.warnAdmins = this.warnAdmins.bind(this)
        this.onSquadBaiting = this.onSquadBaiting.bind(this)
        this.formatActionContent = this.formatActionContent.bind(this)
        this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
        this.onPlayerConnected = this.onPlayerConnected.bind(this);
        this.onNewGame = this.onNewGame.bind(this);
        this.resetPlayerCounters = this.resetPlayerCounters.bind(this);
        this.sendDiscordRuleLog = this.sendDiscordRuleLog.bind(this);
        this.getSquads = this.getSquads.bind(this);
        this.pollSquads = this.pollSquads.bind(this);
        // this.discordLog = this.discordLog.bind(this)

        this.playerBaiting = new Map();
        this.squadsBaiting = new Map();
        this.oldSquads = [];
        this.pollInterval = null;
        this.pollPromise = null;

        this.broadcast = (msg) => this.server.rcon.broadcast(msg);
        this.warn = (steamid, msg) => this.server.rcon.warn(steamid, msg);
    }

    async mount() {
        this.server.on('SQUAD_CREATED', this.onSquadCreated);
        this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
        this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
        this.server.on('NEW_GAME', this.onNewGame);

        await this.pollSquads();
        this.pollInterval = setInterval(this.pollSquads, 5000)
    }

    async pollSquads() {
        if (this.pollPromise) return this.pollPromise;
        this.pollPromise = this.refreshSquads();
        try {
            await this.pollPromise;
        } catch (error) {
            this.verbose(1, 'Could not refresh squad-baiting state', error);
        } finally {
            this.pollPromise = null;
        }
    }

    async refreshSquads() {
        const players = this.server.players;
        const newSquads = (await this.getSquads()).map(squad => ({
            ...squad,
            leader: players.find(player =>
                player.squadID == squad.squadID &&
                player.teamID == squad.teamID &&
                (player.isLeader === true || player.isLeader === 'True'))
        }));
        for (const oldSquad of this.oldSquads) {
            if (!oldSquad.leader) continue;
            const currentSquad = newSquads.find(squad =>
                squad.squadID == oldSquad.squadID &&
                squad.teamID == oldSquad.teamID &&
                squad.squadName == oldSquad.squadName);
            const oldLeaderID = oldSquad.leader.eosID ?? oldSquad.leader.steamID;
            const currentLeaderID = currentSquad?.leader?.eosID ?? currentSquad?.leader?.steamID;
            if (!currentSquad?.leader || !oldLeaderID || currentLeaderID == oldLeaderID) continue;
            const creatorID = oldSquad.creatorEOSID ?? oldSquad.creatorSteamID ?? 'unknown';
            const squadID = `${oldSquad.teamID};${oldSquad.squadID};${oldSquad.squadName};${creatorID}`;
            const playerBaits = (this.playerBaiting.get(oldLeaderID) || 0) + 1;
            const squadBaits = (this.squadsBaiting.get(squadID) || 0) + 1;
            this.playerBaiting.set(oldLeaderID, playerBaits)
            this.squadsBaiting.set(squadID, squadBaits)
            oldSquad.baitingCounter = squadBaits
            oldSquad.leader.baitingCounter = playerBaits
            await this.onSquadBaiting(oldSquad, currentSquad)
        }
        this.oldSquads = [ ...newSquads ];
    }

    onSquadCreated(info) {
        this.verbose(1, "Squad Created:", info.player.teamID, info.player.squadID)
    }

    async unmount() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = null;
        await this.pollPromise;
        this.server.removeEventListener('SQUAD_CREATED', this.onSquadCreated);
        this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
        this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
        this.server.removeEventListener('NEW_GAME', this.onNewGame);
        this.verbose(1, 'Un-mounted.');
    }

    async warnAdmins(message) {
        const admins = await this.server.getAdminsWithPermission('canseeadminchat');
        if (!this.options.warnInGameAdmins) return;
        for (const player of this.server.players) {
            if (!admins.includes(player.steamID)) continue;

            await this.warn(player.steamID, message);
        }
    }

    async onSquadBaiting(oldSquad, newSquad) {
        // this.verbose(1, 'Squad baiting', oldSquad, newSquad)
        // await this.warn(oldSquad.leader.steamID, 'Squad baiting is not allowed!')
        if (!this.options.disableDefaultAdminWarns) await this.warnAdmins(`[${oldSquad.leader.name}] is doing squad baiting.\n  Player's baits: ${oldSquad.leader.baitingCounter}\n\n  Squad Info:\n   Name: ${oldSquad.squadName}\n   Number: ${oldSquad.squadID}\n   Team: ${oldSquad.leader.role.split('_')[ 0 ]} (${oldSquad.teamID})\n   Baits: ${oldSquad.baitingCounter}`)

        const activePlayerRules = this.options.playerRules.filter(r => r.enabled && r.baitingCounter.min <= oldSquad.leader.baitingCounter && r.baitingCounter.max >= oldSquad.leader.baitingCounter).map(r => ({ ...r, type: 'Player' }));
        const activeSquadRules = this.options.squadRules.filter(r => r.enabled && r.baitingCounter.min <= oldSquad.baitingCounter && r.baitingCounter.max >= oldSquad.baitingCounter).map(r => ({ ...r, type: 'Squad' }));
        this.verbose(1, 'Triggered PLAYER rules', activePlayerRules.map(r => r.name))
        this.verbose(1, 'Triggered SQUAD rules', activeSquadRules.map(r => r.name))

        for (let r of activePlayerRules.concat(activeSquadRules)) {
            if (!r.enabled) continue;
            for (let a of r.actions.filter(act => act.enabled || act.enabled == undefined)) {
                const formattedContent = this.formatActionContent(a.content, oldSquad, newSquad);
                a.formattedContent = formattedContent
                // this.verbose(1, 'Formatted action content', formattedContent)
                switch (a.type.toLowerCase()) {
                    case 'rcon':
                        await this.server.rcon.execute(formattedContent)
                        break;
                    case 'warn-admins':
                    case 'warnadmins':
                    case 'warn_admins':
                        await this.warnAdmins(formattedContent)
                        break;
                }
            }
            await this.sendDiscordRuleLog(r, oldSquad, newSquad);
        }
    }

    async onPlayerDisconnected(info) {
        const playerID = info.player.eosID ?? info.player.steamID;
        // this.verbose(1, 'Disconnected', steamID, playerName, info)
        this.resetPlayerCounters(playerID)
    }
    async onPlayerConnected(info) {
        const playerID = info.player.eosID ?? info.player.steamID;
        this.resetPlayerCounters(playerID)
    }

    resetPlayerCounters(steamID) {
        this.playerBaiting.set(steamID, 0)
    }

    async onNewGame(info) {
        this.squadsBaiting = new Map();

        if (this.options.resetPlayerCountersAtNewGame)
            this.playerBaiting = new Map();
    }

    formatActionContent(content, oldSquad, newSquad) {
        return content
            .replace(/\{squad:teamid\}/ig, oldSquad.teamID)
            .replace(/\{squad:id\}/ig, oldSquad.squadID)
            .replace(/\{squad:squadid\}/ig, oldSquad.squadID)
            .replace(/\{squad:name\}/ig, oldSquad.squadName)
            .replace(/\{squad:teamname\}/ig, oldSquad.leader.role.split('_')[ 0 ])
            .replace(/\{squad:baitingcounter\}/ig, oldSquad.baitingCounter)
            .replace(/\{old_leader:username\}/ig, oldSquad.leader.name)
            .replace(/\{old_leader:steamid\}/ig, oldSquad.leader.steamID)
            .replace(/\{old_leader:baitingcounter\}/ig, oldSquad.leader.baitingCounter)
            .replace(/\{new_leader:username\}/ig, newSquad?.leader?.name)
            .replace(/\{new_leader:steamid\}/ig, newSquad?.leader?.steamID)
            .replace(/\{new_leader:baitingcounter\}/ig, newSquad?.leader?.baitingCounter)
    }

    async sendDiscordRuleLog(rule, oldSquad, newSquad) {
        if (rule.discordLogging === false) return;
        const actionsEmbedFields = rule.actions.filter(act => act.enabled || act.enabled == undefined).map(a => ({ name: a.type.toUpperCase(), value: `\`\`\`${a.formattedContent}\`\`\``, inline: false }))
        await this.sendDiscordMessage({
            embed: {
                title: `[${oldSquad.leader.name}] Squad-Baiting`,
                color: "ee1111",
                fields: [
                    {
                        name: 'Leader\'s Username',
                        value: oldSquad.leader.name,
                        inline: true
                    },
                    {
                        name: 'Leader\'s SteamID',
                        value: `[${oldSquad.leader.steamID}](https://steamcommunity.com/profiles/${oldSquad.leader.steamID})`,
                        inline: true
                    },
                    {
                        name: 'Team & Squad',
                        value: `Team: ${oldSquad.teamID}, Squad: ${oldSquad.squadID}`,
                        inline: true
                    },
                    {
                        name: 'Squad',
                        value: oldSquad.squadName,
                        inline: true
                    },
                    {
                        name: 'Team',
                        value: oldSquad.leader.role.split('_')[ 0 ],
                        inline: true
                    },
                    {
                        name: 'Triggered Rules',
                        value: rule.name,
                        inline: false
                    },
                    {
                        name: 'Executed Actions',
                        value: ':small_red_triangle_down: :small_red_triangle_down: :small_red_triangle_down: :small_red_triangle_down: :small_red_triangle_down:',
                        inline: false
                    },
                    ...actionsEmbedFields
                ]
            },
            timestamp: (new Date()).toISOString()
        });
    }

    async getSquads() {
        return this.server.rcon.getSquads();
    }
}
