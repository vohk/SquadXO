import type { Client as DiscordClient } from 'discord.js';
import type { Sequelize } from 'sequelize';
import type { SquadEventName, SquadEventPayload } from '../domain/events.js';
import type { EOSID } from '../domain/identity.js';
import type { ServerStateSnapshot } from '../domain/server-state.js';
import type { LayerInformation, RconPlayer, RconSquad } from '../rcon/squad-protocol.js';

export const PLUGIN_API_VERSION = 1 as const;

export interface PluginLogger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface PluginRcon {
  listPlayers(): Promise<RconPlayer[]>;
  listSquads(): Promise<RconSquad[]>;
  showCurrentMap(): Promise<LayerInformation>;
  showNextMap(): Promise<LayerInformation>;
  showServerInfo(): Promise<Readonly<Record<string, unknown>>>;
  broadcast(message: string): Promise<void>;
  warn(eosID: EOSID, message: string): Promise<void>;
  kick(eosID: EOSID, reason: string): Promise<void>;
  ban(eosID: EOSID, interval: string, reason: string): Promise<void>;
  forceTeamChange(eosID: EOSID): Promise<void>;
}

export interface PluginLogSnapshotOptions {
  readonly maximumBytes: number;
}

export interface PluginLogSnapshot {
  readonly sourceBytes: number;
  readonly modifiedAt?: Date;
}

export interface PluginLogs {
  copyCurrent(destination: string, options: PluginLogSnapshotOptions): Promise<PluginLogSnapshot>;
}

/** Identity of the SquadXO instance from `config.server`. */
export interface PluginServerIdentity {
  readonly id: number;
  readonly name?: string;
}

export type NativeOptionType = 'string' | 'number' | 'boolean' | 'string[]' | 'object';

export interface NativeOptionDeclaration<Type extends NativeOptionType = NativeOptionType> {
  readonly type: Type;
  readonly required?: boolean;
  readonly default?: OptionTypeValue<Type>;
  readonly description?: string;
}

export type NativeOptionSchema = Readonly<Record<string, NativeOptionDeclaration>>;

export type OptionTypeValue<Type extends NativeOptionType> = Type extends 'string'
  ? string
  : Type extends 'number'
    ? number
    : Type extends 'boolean'
      ? boolean
      : Type extends 'string[]'
        ? readonly string[]
        : Readonly<Record<string, unknown>>;

type RequiredNativeOptionNames<Schema extends NativeOptionSchema> = {
  [Name in keyof Schema]: Schema[Name] extends { readonly required: true }
    ? Name
    : Schema[Name] extends { readonly default: unknown }
      ? Name
      : never;
}[keyof Schema];

export type ResolvedNativeOptions<Schema extends NativeOptionSchema> = {
  readonly [Name in RequiredNativeOptionNames<Schema>]: OptionTypeValue<Schema[Name]['type']>;
} & {
  readonly [Name in Exclude<keyof Schema, RequiredNativeOptionNames<Schema>>]?: OptionTypeValue<
    Schema[Name]['type']
  >;
};

export type NativeConnectorType = 'discord' | 'sequelize';

export interface NativeConnectorDeclaration<
  Type extends NativeConnectorType = NativeConnectorType
> {
  readonly type: Type;
  readonly required?: boolean;
  readonly description?: string;
}

export type NativeConnectorSchema = Readonly<Record<string, NativeConnectorDeclaration>>;

export type ConnectorTypeValue<Type extends NativeConnectorType> = Type extends 'discord'
  ? DiscordClient
  : Sequelize;

type RequiredNativeConnectorNames<Schema extends NativeConnectorSchema> = {
  [Name in keyof Schema]: Schema[Name] extends { readonly required: false } ? never : Name;
}[keyof Schema];

export interface PluginContext<
  Options extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  Connectors extends NativeConnectorSchema = NativeConnectorSchema
> {
  on<EventName extends SquadEventName>(
    event: EventName,
    handler: (payload: SquadEventPayload<EventName>) => void | Promise<void>
  ): () => void;
  snapshot(): ServerStateSnapshot;
  connector<Name extends RequiredNativeConnectorNames<Connectors> & string>(
    name: Name
  ): ConnectorTypeValue<Connectors[Name]['type']>;
  optionalConnector<Name extends keyof Connectors & string>(
    name: Name
  ): ConnectorTypeValue<Connectors[Name]['type']> | undefined;
  setTimeout(handler: () => void | Promise<void>, delayMs: number): () => void;
  setInterval(handler: () => void | Promise<void>, intervalMs: number): () => void;
  track(task: Promise<unknown>): void;
  readonly options: Options;
  readonly server: PluginServerIdentity;
  readonly logs: PluginLogs;
  readonly rcon: PluginRcon;
  readonly logger: PluginLogger;
  readonly signal: AbortSignal;
}

export interface Plugin<
  Options extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  Connectors extends NativeConnectorSchema = NativeConnectorSchema
> {
  mount(context: PluginContext<Options, Connectors>): void | Promise<void>;
  unmount?(): void | Promise<void>;
}

export interface NativePluginDefinition<
  Options extends NativeOptionSchema = NativeOptionSchema,
  Connectors extends NativeConnectorSchema = NativeConnectorSchema
> {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly description?: string;
  readonly name: string;
  readonly options: Options;
  readonly connectors: Connectors;
  create(): Plugin<ResolvedNativeOptions<Options>, Connectors>;
}

export function definePlugin<
  const Options extends NativeOptionSchema,
  const Connectors extends NativeConnectorSchema
>(
  definition: NativePluginDefinition<Options, Connectors>
): NativePluginDefinition<Options, Connectors> {
  return definition;
}
