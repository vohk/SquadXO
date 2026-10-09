import type { Client, SendableChannels } from 'discord.js';
import type { RoundEndedEvent } from '../../domain/events.js';
import { definePlugin, type PluginContext } from '../api.js';

const options = {
  channelIDs: {
    type: 'string[]',
    default: [],
    description: 'Discord channels that receive completed match results.'
  },
  color: {
    type: 'number',
    default: 16761867,
    description: 'The color of the result embed.'
  }
} as const;

const connectors = {
  discord: {
    type: 'discord',
    description: 'Discord bot used to deliver completed match results.'
  }
} as const;

type DiscordRoundEndedOptions = {
  readonly channelIDs: readonly string[];
  readonly color: number;
};

type DiscordRoundEndedContext = PluginContext<DiscordRoundEndedOptions, typeof connectors>;

interface PreparedChannel {
  readonly id: string;
  readonly channel: SendableChannels;
}

export default definePlugin({
  apiVersion: 1,
  name: 'discordRoundEnded',
  description: 'Posts end-of-round results to configured Discord channels.',
  options,
  connectors,
  create() {
    return {
      async mount(context) {
        const channelIDs = uniqueChannelIDs(context.options.channelIDs);
        validateOptions(channelIDs);
        const discord = context.connector('discord');
        const channels = await Promise.all(
          channelIDs.map(async (id) => ({
            id,
            channel: await fetchChannel(discord, id)
          }))
        );

        context.on('ROUND_ENDED', (event) => {
          context.track(deliverRoundEnded(channels, event, context));
        });
        context.logger.info('Mounted', {
          event: 'discord_round_ended_mounted',
          channelIDs
        });
      }
    };
  }
});

async function fetchChannel(discord: Client, channelID: string): Promise<SendableChannels> {
  try {
    const channel = await discord.channels.fetch(channelID);
    if (!channel?.isSendable()) {
      throw new Error('channel is not sendable');
    }
    return channel;
  } catch (error) {
    throw new Error(`Discord channel ${channelID} could not be prepared: ${errorMessage(error)}`, {
      cause: error
    });
  }
}

function uniqueChannelIDs(channelIDs: readonly string[]): string[] {
  return [...new Set(channelIDs)];
}

function validateOptions(channelIDs: readonly string[]): void {
  if (channelIDs.length === 0) {
    throw new Error('At least one channelIDs entry is required');
  }
  if (channelIDs.some((channelID) => !/^\d{15,22}$/.test(channelID))) {
    throw new Error('channelIDs must contain only Discord channel IDs');
  }
}

async function deliverRoundEnded(
  channels: readonly PreparedChannel[],
  event: RoundEndedEvent,
  context: DiscordRoundEndedContext
): Promise<void> {
  const message = createMessage(event, context.options.color);
  await Promise.all(
    channels.map(async ({ id, channel }) => {
      try {
        await channel.send(message);
      } catch (error) {
        context.logger.error('Failed to deliver round result', {
          event: 'discord_round_ended_delivery',
          channelID: id,
          error: errorMessage(error)
        });
      }
    })
  );
}

function createMessage(event: RoundEndedEvent, color: number) {
  if (!event.winner || !event.loser) {
    return {
      embeds: [
        {
          title: 'Round Ended',
          description: 'This match Ended in a Draw',
          color,
          timestamp: event.time.toISOString()
        }
      ]
    };
  }

  const { winner, loser } = event;
  const ticketDifference =
    winner.tickets === undefined || loser.tickets === undefined
      ? 'Unknown'
      : `${winner.tickets - loser.tickets}`;
  return {
    embeds: [
      {
        title: 'Round Ended',
        description: `${winner.layer ?? 'Unknown layer'} - ${winner.level ?? 'Unknown level'}`,
        color,
        fields: [
          {
            name: `Team ${winner.team} Won`,
            value: `${winner.subfaction ?? 'Unknown'}\n ${winner.faction ?? 'Unknown'}\n won with ${winner.tickets ?? 'unknown'} tickets.`
          },
          {
            name: `Team ${loser.team} Lost`,
            value: `${loser.subfaction ?? 'Unknown'}\n ${loser.faction ?? 'Unknown'}\n lost with ${loser.tickets ?? 'unknown'} tickets.`
          },
          {
            name: 'Ticket Difference',
            value: `${ticketDifference}.`
          }
        ],
        timestamp: event.time.toISOString()
      }
    ]
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
