import DiscordBasePlugin from './discord-base-plugin.js';

export default class DiscordRoundWinner extends DiscordBasePlugin {
  static get description() {
    return 'Deprecated: use the native <code>discordRoundEnded</code> plugin. This compatibility plugin sends the round winner after the next layer loads.';
  }

  static get defaultEnabled() {
    return false;
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
      color: {
        required: false,
        description: 'The color of the embed.',
        default: 16761867
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onNewGame = this.onNewGame.bind(this);
  }

  async mount() {
    this.server.on('NEW_GAME', this.onNewGame);
  }

  async unmount() {
    this.server.removeEventListener('NEW_GAME', this.onNewGame);
  }

  async onNewGame(info) {
    const completedLayer = this.server.layerHistory[1]?.layer;
    await this.sendDiscordMessage({
      embed: {
        title: 'Round Winner',
        color: this.options.color,
        fields: [
          {
            name: 'Message',
            value: `${info.winner ?? 'Unknown team'} won on ${completedLayer?.name ?? info.layer ?? 'Unknown layer'}.`
          }
        ],
        timestamp: info.time.toISOString()
      }
    });
  }
}
