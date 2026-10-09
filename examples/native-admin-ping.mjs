import { definePlugin } from 'SquadJS/plugin-api';

export default definePlugin({
  apiVersion: 1,
  name: 'NativeAdminPing',
  options: {
    response: {
      type: 'string',
      default: 'A native SquadJS plugin received your command.',
      description: 'Message sent to the player through the owned RCON client.'
    }
  },
  connectors: {
    database: {
      type: 'sequelize',
      description: 'Named SQL connector selected by the operator.'
    }
  },
  create() {
    return {
      mount(context) {
        // Resolve the declared alias during mount so configuration errors are fatal at startup.
        context.connector('database');
        context.on('CHAT_COMMAND:nativeping', async ({ player }) => {
          if (player) await context.rcon.warn(player.eosID, context.options.response);
        });
        context.logger.info('Mounted');
      }
    };
  }
});
