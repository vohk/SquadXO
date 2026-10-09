import DiscordBasePlugin from './discord-base-plugin.js';
import Layers from '../layers/layers.js';

export default class VehicleEnteredLogger extends DiscordBasePlugin {
    static get description() {
        return "Vehicle seat entered logger plugin";
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
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.discordLog = this.discordLog.bind(this);
        this.onLogLine = this.onLogLine.bind(this);
        this.onPossess = this.onPossess.bind(this);
        this.getVehicleFromAssetName = this.getVehicleFromAssetName.bind(this);
        this.setCurrentLayer = this.setCurrentLayer.bind(this);
        this.updatedLayerInformation = this.updatedLayerInformation.bind(this);

        this.currentLayer = null;

        this.setupDone = false;

        this.broadcast = (msg) => this.server.rcon.broadcast(msg);
        this.warn = (steamid, msg) => this.server.rcon.warn(steamid, msg);
    }

    async mount() {
        await Layers.pull();
        await this.setCurrentLayer(this.server.currentLayer);

        this.server.on('UPDATED_LAYER_INFORMATION', this.updatedLayerInformation)

        this.server.on('RAW_LOG_LINE', this.onLogLine)

        this.verbose(1, 'Mounted')
    }

    onLogLine(line) {
        if (!this.setupDone) return;

        let regMatch;

        regMatch = line.match(/OnPossess\(\): PC=(?<playerName>.+) \(Online IDs: EOS: (?<eosID>[\w\d]{32})(?: ?steam: (?<steamID>\d{17}))\) Entered Vehicle Pawn=(?<pawn>(?<assetName>.+)_\d+) \(Asset Name = (?<vehicleName>[^\s]+)\) FullPath=(?<path>BP_.+).+Seat Number=(?<seatNumber>\d+)/)
        if (regMatch) return this.onPossess(regMatch.groups)
    }

    async onPossess(data) {
        await this.discordLog(data)
    }

    async discordLog(data) {
        const vehicleName = this.getVehicleFromAssetName(data.vehicleName)?.name;

        await this.sendDiscordMessage({
            embed: {
                title: `${data.playerName} entered: ${vehicleName || data.vehicleName}, seat: ${data.seatNumber}`,
                color: "00cccc",
                fields: [
                    {
                        name: 'Player',
                        value: data.playerName,
                        inline: true
                    },
                    {
                        name: 'SteamID',
                        value: `[${data.steamID}](https://steamcommunity.com/profiles/${data.steamID})`,
                        inline: true
                    },
                    {
                        name: 'EOS ID',
                        value: `${data.eosID}`,
                        inline: true
                    },
                    {
                        name: 'URLs',
                        value: `[Steam](https://steamcommunity.com/profiles/${data.steamID}) | [Battlemetrics](https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${data.eosID}&filter%5Bservers%5D=false&filter%5BplayerFlags%5D=&sort=-lastSeen&showServers=true&method=quick&redirect=1) | [CBL](https://communitybanlist.com/search/${data.steamID})`,
                        inline: true
                    },
                    {
                        name: 'Layer',
                        value: this.server.currentLayer?.name ?? 'Unknown layer'
                    },
                    {
                        name: 'Asset',
                        value: data.vehicleName,
                        inline: true
                    },
                    {
                        name: 'Vehicle',
                        value: vehicleName,
                        inline: true
                    },
                    {
                        name: 'Seat',
                        value: data.seatNumber,
                        inline: true
                    },
                ],
                timestamp: (new Date()).toISOString()
            }
        });
    }

    async setCurrentLayer(layer) {
        const layerID = typeof layer === 'string' ? layer : layer?.layerid ?? layer?.name;
        this.verbose(1, `Current layer: ${layerID ?? 'unknown'}`)
        this.currentLayer = layer?.teams?.length ? layer : layerID ? await Layers.getLayerById(layerID) : null;
        this.setupDone = Boolean(this.currentLayer);
    }

    async updatedLayerInformation() {
        await this.setCurrentLayer(this.server.currentLayer)
    }

    getVehicleFromAssetName(assetName) {
        const allVehicles = this.currentLayer?.teams?.flatMap(team => team.vehicles ?? []) ?? [];
        return allVehicles.find(vehicle =>
            vehicle.classname === assetName || vehicle.classNames?.includes(assetName));
    }

    async unmount() {
        this.server.removeEventListener('UPDATED_LAYER_INFORMATION', this.updatedLayerInformation)
        this.server.removeEventListener('RAW_LOG_LINE', this.onLogLine)
        this.verbose(1, 'Un-mounted.');
    }
}
