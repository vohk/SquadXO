import DiscordBasePlugin from './discord-base-plugin.js';

export default class DiscordChatRaw extends DiscordBasePlugin {
  static get description() {
    return 'The DiscordChatRaw plugin logs in-game chat to a Discord channel.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the channel used for raw chat logs.',
        default: '',
        example: '667741905228136459'
      },
      ignoreChats: {
        required: false,
        default: ['ChatSquad'],
        description: 'A list of chat names to ignore.'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onChatMessage = this.onChatMessage.bind(this);
  }

  async mount() {
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
  }

  async unmount() {
    this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
  }

  async onChatMessage(info) {
    if (this.options.ignoreChats.includes(info.chat)) return;

    await this.sendDiscordMessage({
      content: `SERVER${this.server.id} [${info.chat}] [${info.player.name}]( <https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${info.steamID}&filter%5Bservers%5D=false&filter%5BplayerFlags%5D=&sort=-lastSeen&showServers=true&method=quick&redirect=1> ): \`${info.message}\``,
      allowedMentions: { parse: [] }
    });
  }
}
