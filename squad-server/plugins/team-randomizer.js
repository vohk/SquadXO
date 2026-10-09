import { readSwitchRoster, switchGroups, moveToTeam } from '../utils/team-switch.js';
import BasePlugin from './base-plugin.js';

export default class TeamRandomizer extends BasePlugin {
  static get description() {
    return (
      "The <code>TeamRandomizer</code> can be used to randomize teams. It's great for destroying clan stacks or for " +
      'social events. It can be run by typing, by default, <code>!randomize</code> into in-game admin chat'
    );
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      command: {
        required: false,
        description: 'The command used to randomize the teams.',
        default: 'randomize'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.onChatCommand = this.onChatCommand.bind(this);
  }

  async mount() {
    this.server.on(`CHAT_COMMAND:${this.options.command}`, this.onChatCommand);
  }

  async unmount() {
    this.server.removeEventListener(`CHAT_COMMAND:${this.options.command}`, this.onChatCommand);
  }

  async onChatCommand(info) {
    if (info.chat !== 'ChatAdmin') return;

    const players = await readSwitchRoster(this.server);
    const groups = switchGroups(players, false);
    for (const teamID of [1, 2]) {
      const candidates = groups.filter((group) => group.teamID === teamID);
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      const target = Math.ceil(players.filter((player) => player.teamID === teamID).length / 2);
      let selected = 0;
      for (const group of candidates) {
        if (selected >= target) break;
        await moveToTeam(this.server, group.players, teamID === 1 ? 2 : 1);
        selected += group.players.length;
      }
    }
  }
}
