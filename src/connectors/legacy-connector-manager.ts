import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { EventEmitter } from 'node:events';
import { Sequelize } from 'sequelize';
import { ConnectorRegistry } from './registry.js';
import type { ConnectorRequirement } from '../compatibility/legacy-plugin-plan.js';

type CloseConnector = () => Promise<void> | void;

export class LegacyConnectorManager {
  #registry = new ConnectorRegistry();
  readonly #closers: CloseConnector[] = [];

  get registry(): ConnectorRegistry {
    return this.#registry;
  }

  async initialize(
    requirements: readonly ConnectorRequirement[],
    configured: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const connectors: Record<string, unknown> = {};
    try {
      for (const requirement of requirements) {
        if (!(requirement.name in configured)) {
          throw new Error(`${requirement.plugin}: connector ${requirement.name} is not configured`);
        }
        const built = await this.#create(requirement, configured[requirement.name]);
        connectors[requirement.name] = built.connector;
        this.#closers.push(built.close);
      }
      this.#registry = new ConnectorRegistry(connectors);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (const close of this.#closers.splice(0).reverse()) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.#registry = new ConnectorRegistry();
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Failed to close one or more connectors');
  }

  async #create(
    requirement: ConnectorRequirement,
    configuration: unknown
  ): Promise<{ connector: unknown; close: CloseConnector }> {
    if (requirement.type === 'discord') {
      const configuredToken = process.env.SQUADJS_DISCORD_TOKEN ?? configuration;
      if (typeof configuredToken !== 'string' || !configuredToken) {
        throw new Error(`Discord connector ${requirement.name} requires a bot token`);
      }
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers
        ]
      });
      installLegacyEventAliases(client);
      client.on('messageCreate', (message) => client.emit('message', message));
      await client.login(configuredToken);
      if (!client.isReady())
        await new Promise<void>((resolveReady) =>
          client.once(Events.ClientReady, () => resolveReady())
        );
      return { connector: client, close: () => client.destroy() };
    }

    if (requirement.type === 'sequelize') {
      if (typeof configuration !== 'string' && !isRecord(configuration)) {
        throw new Error(`Sequelize connector ${requirement.name} has an invalid configuration`);
      }
      const sequelize =
        typeof configuration === 'string'
          ? new Sequelize(configuration, { logging: false })
          : new Sequelize({ ...configuration, logging: false } as never);
      await sequelize.authenticate();
      return { connector: sequelize, close: () => sequelize.close() };
    }

    throw new Error(`Unsupported connector type: ${requirement.type}`);
  }
}

export function installLegacyEventAliases(client: EventEmitter): void {
  const legacy = client as EventEmitter & {
    removeEventListener?: (event: string, listener: (...arguments_: any[]) => void) => EventEmitter;
  };
  if (typeof legacy.removeEventListener !== 'function') {
    Object.defineProperty(legacy, 'removeEventListener', {
      configurable: true,
      value: (event: string, listener: (...arguments_: any[]) => void) =>
        client.removeListener(event, listener)
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
