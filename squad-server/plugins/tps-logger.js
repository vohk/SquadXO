import DiscordBasePlugin from './discord-base-plugin.js';

import * as http from 'http';

export default class TpsLogger extends DiscordBasePlugin {
    static get description() {
        return "TPS Logger plugin";
    }

    static get defaultEnabled() {
        return true;
    }

    static get optionsSpecification() {
        return {
            ...DiscordBasePlugin.optionsSpecification,
            commandPrefix: {
                required: false,
                description: "Prefix of every in-game command",
                default: "!tps"
            },
            httpServerEnabled: {
                required: true,
                description: "Enables/Disables the http server that hosts the TPS history with events",
                default: false
            },
            httpServerPort: {
                required: false,
                description: "The port used by the http server",
                default: 3030
            },
            tpsHistoryLength: {
                required: false,
                description: "",
                default: 200
            },
            simulateTpsDrops: {
                required: false,
                description: "",
                default: false
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.tickRates = []
        this.httpServerInstance = null;
        this.eventListeners = new Map();

        this.tickRateUpdated = this.tickRateUpdated.bind(this);
        this.httpServer = this.httpServer.bind(this);
        this.pushEventInTpsHistory = this.pushEventInTpsHistory.bind(this);
        this.bindListeners = this.bindListeners.bind(this);
        this.logLineReceived = this.logLineReceived.bind(this);
        this.getLatestTpsRecord = this.getLatestTpsRecord.bind(this);
        this.pushLogInTpsHistory = this.pushLogInTpsHistory.bind(this);
        this.getAverageTps = this.getAverageTps.bind(this);
        this.clearLogHistoryInTpsRecord = this.clearLogHistoryInTpsRecord.bind(this);
        this.canClearLog = this.canClearLog.bind(this);
    }

    async mount() {
        await this.httpServer();
        this.bindListeners();
        this.server.on('TICK_RATE', this.tickRateUpdated)
        this.server.on('RAW_LOG_LINE', this.logLineReceived)
    }

    async unmount() {
        this.server.removeEventListener('TICK_RATE', this.tickRateUpdated);
        this.server.removeEventListener('RAW_LOG_LINE', this.logLineReceived);
        for (const [event, listener] of this.eventListeners) {
            this.server.removeEventListener(event, listener);
        }
        this.eventListeners.clear();
        if (this.httpServerInstance?.listening) {
            await new Promise(resolve => this.httpServerInstance.close(resolve));
        }
        this.httpServerInstance = null;
        this.verbose(1, 'TpsLogger unmounted');
    }

    async httpServer() {
        if (this.options.httpServerEnabled) {
            try {
                const server = http.createServer((req, res) => {
                    res.setHeader('Content-Type', 'application/json');
                    res.write(JSON.stringify(this.tickRates, null, 2));
                    res.end();
                });
                await new Promise((resolve, reject) => {
                    const onError = error => reject(error);
                    server.once('error', onError);
                    server.listen(this.options.httpServerPort, () => {
                        server.removeListener('error', onError);
                        resolve();
                    });
                });
                this.httpServerInstance = server;
            } catch (e) {
                this.verbose(1, `Could not start the HTTP server. Error:`, e)
                throw e;
            }
            this.verbose(1, `HTTP server started on port ${this.options.httpServerPort}`)
        }
    }

    pushEventInTpsHistory(name, data) {
        const index = this.tickRates.length == 0 ? 0 : this.tickRates.length - 1;
        if (!this.tickRates[ index ]) return;
        this.tickRates[ index ].events.push({ eventName: name, data: data })
    }

    tickRateUpdated(dt) {
        this.verbose(1, 'TPS Update', dt)
        const tps = this.options.simulateTpsDrops && Math.floor(Math.random() * 2) == 1 ? 25 : dt.tickRate;
        this.tickRates.push({
            tickRate: tps,
            averageTickRate: 0,
            time: dt.time,
            playerCount: this.server.players.length,
            layer: this.server.currentLayer?.layerid ?? this.server.currentLayer?.name ?? null,
            events: [],
            logs: {
                count: 0,
                history: []
            }
        })

        if (this.tickRates.length > this.options.tpsHistoryLength) this.tickRates.shift();

        const latestTpsRecordIndex = this.getLatestTpsRecord();
        this.tickRates[ latestTpsRecordIndex ].averageTickRate = this.getAverageTps();
        this.clearLogHistoryInTpsRecord(latestTpsRecordIndex - 1)
    }

    async logLineReceived(dt) {
        this.verbose(2, `Received log line`, dt)
        this.pushLogInTpsHistory(dt)
    }

    pushLogInTpsHistory(log) {
        this.verbose(1, `Adding log to tps history`)
        const index = this.getLatestTpsRecord();
        if (!this.tickRates[ index ]) return;
        this.tickRates[ index ].logs.history.push(log);
        this.tickRates[ index ].logs.count++;
    }

    clearLogHistoryInTpsRecord(tpsRecordIndex) {
        this.verbose(1, `Checking permission to clear log history ${tpsRecordIndex}`)
        if (tpsRecordIndex < 0 || tpsRecordIndex >= this.tickRates.length) return;
        if (!this.canClearLog(tpsRecordIndex)) return;
        this.verbose(1, `Clearing log history ${tpsRecordIndex}`)
        this.tickRates[ tpsRecordIndex ].logs.history = [];
    }

    canClearLog(tpsRecordIndex) {
        // this.verbose(1, `Tickrate length:`, this.tickRates.length)
        // this.verbose(1, `Prev tickrate *0.75`, this.tickRates[ tpsRecordIndex - 1 ].tickRate * 0.75)
        // this.verbose(1, `Prev cond`, this.tickRates[ tpsRecordIndex - 1 ].tickRate * 0.75 < this.tickRates[ tpsRecordIndex ].tickRate)
        // this.verbose(1, `Next cond`, this.tickRates[ tpsRecordIndex ].tickRate * 0.75 < this.tickRates[ tpsRecordIndex + 1 ].tickRate)
        return (
            tpsRecordIndex > 0 &&
            tpsRecordIndex + 1 < this.tickRates.length &&
            this.tickRates[ tpsRecordIndex - 1 ].tickRate * 0.75 < this.tickRates[ tpsRecordIndex ].tickRate &&
            this.tickRates[ tpsRecordIndex ].tickRate * 0.75 < this.tickRates[ tpsRecordIndex + 1 ].tickRate
        )
    }

    getLatestTpsRecord() {
        return this.tickRates.length == 0 ? 0 : this.tickRates.length - 1;
    }

    getAverageTps() {
        return this.tickRates.map(t => t.tickRate).reduce((acc, cur) => acc + cur, 0) / this.tickRates.length || 0
    }

    bindListeners() {
        const events = new Set([
            "ADMIN_BROADCAST",
            "CLIENT_CONNECTED",
            "CLIENT_LOGIN",
            "DEPLOYABLE_DAMAGED",
            "NEW_GAME",
            "PENDING_CONNECTION_DESTROYED",
            "PLAYER_CONNECTED",
            "PLAYER_DAMAGED",
            "PLAYER_DIED",
            "PLAYER_DISCONNECTED",
            "PLAYER_POSSESS",
            "PLAYER_REVIVED",
            "PLAYER_UNPOSSESS",
            "PLAYER_WOUNDED",
            "PLAYER_CONTROLLER_CONNECTED",
            "ROUND_ENDED",
            "NEW_GAME",
            "PLAYER_SQUAD_CHANGE",
            "TEAMKILL",
            "PLAYER_CONNECTED",
            "CHAT_MESSAGE",
            "DEPLOYABLE_DAMAGED",
            "ROUND_ENDED"
        ])

        for (const e of events) {
            this.verbose(1, "Binding", e)
            const listener = (data) => { this.pushEventInTpsHistory(e, data) };
            this.eventListeners.set(e, listener);
            this.server.on(e, listener)
        }
    }
}
