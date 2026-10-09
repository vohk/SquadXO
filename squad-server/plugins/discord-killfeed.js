import DiscordBasePlugin from './discord-base-plugin.js';

export default class DiscordKillFeed extends DiscordBasePlugin {
  static get description() {
    return (
      'The <code>DiscordKillFeed</code> plugin logs all wounds and related information to a Discord channel for ' +
      'admins to review.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the channel to log teamkills to.',
        default: '',
        example: '667741905228136459'
      },
      color: {
        required: false,
        description: 'The color of the embeds.',
        default: 16761867
      },
      disableCBL: {
        required: false,
        description: 'Disable Community Ban List information.',
        default: false
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onWound = this.onWound.bind(this);
  }

  async mount() {
    this.server.on('PLAYER_WOUNDED', this.onWound);
  }

  async unmount() {
    this.server.removeEventListener('PLAYER_WOUNDED', this.onWound);
  }

  async onWound(info) {
    if (info.attacker){
      var attackerSteamId = `(${info.attacker.steamID} [↗](<https://steamcommunity.com/profiles/${info.attacker.steamID}>))`;
      var attackerBm = `[\`BM\`](<https://www.battlemetrics.com/rcon/players?filter[search]=${info.attacker.steamID}&method=quick&redirect=1>)`;
      var attacker = `\`${info.attacker.name}\` ${attackerSteamId} [${attackerBm}]`;
    }else attacker = `\`Unknown\``;

    if(info.victim){
      var victimSteamId = `(${info.victim.steamID} [↗](<https://steamcommunity.com/profiles/${info.victim.steamID}>))`;
      var victimBm = `[\`BM\`](<https://www.battlemetrics.com/rcon/players?filter[search]=${info.victim.steamID}&method=quick&redirect=1>)`;
      var victim = info.victim ? `\`${info.victim.name}\` ${victimSteamId} [${victimBm}]` : "Unknown";
    }else victim = `\`Unknown\``;

    var weapon = info.weapon ? `\`${info.weapon}\`` : "Unknown";

    await this.sendDiscordMessage(`${attacker} killed ${victim} using ${weapon} at <t:${Math.round(info.time.valueOf() / 1000)}:T>`);

    // await this.sendDiscordMessage({
    //   embed: {
    //     title: `KillFeed: ${info.attacker.name}`,
    //     color: this.options.color,
    //     fields: fields,
    //     timestamp: info.time.toISOString()
    //   }
    // });
  }
}