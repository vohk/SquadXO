import type { ConnectorRegistry } from '../connectors/registry.js';
import type { SquadEventName, SquadEventPayload } from '../domain/events.js';
import type { EOSID } from '../domain/identity.js';
import type { ServerState } from '../domain/server-state.js';
import type { SquadRconClient } from '../rcon/client.js';
import type { LegacyServerHost, PluginFailure } from '../compatibility/legacy-server-facade.js';
import type { LogReader } from '../logs/reader.js';
import type {
  NativeConnectorSchema,
  Plugin,
  PluginContext,
  PluginLogger,
  PluginRcon,
  PluginServerIdentity
} from './api.js';

interface OwnedResources {
  readonly abort: AbortController;
  readonly unsubscribers: (() => void)[];
  readonly timers: Set<NodeJS.Timeout>;
  readonly tasks: Set<Promise<void>>;
}

interface MountedPlugin extends OwnedResources {
  readonly name: string;
  readonly plugin: Plugin;
}

export class PluginRuntime {
  readonly #state: ServerState;
  readonly #pluginRcon: PluginRcon;
  readonly #connectors: ConnectorRegistry;
  readonly #events: LegacyServerHost;
  readonly #logs: Pick<LogReader, 'copySnapshot'> | undefined;
  readonly #server: PluginServerIdentity;
  readonly #logger: (
    plugin: string,
    level: keyof PluginLogger,
    message: string,
    details?: unknown
  ) => void;
  readonly #onFailure: (failure: PluginFailure) => void;
  readonly #shutdownTimeoutMs: number;
  readonly #plugins: MountedPlugin[] = [];

  constructor(options: {
    readonly state: ServerState;
    readonly rcon: SquadRconClient;
    readonly connectors: ConnectorRegistry;
    readonly events: LegacyServerHost;
    readonly logs?: Pick<LogReader, 'copySnapshot'>;
    readonly server?: PluginServerIdentity;
    readonly logger?: (
      plugin: string,
      level: keyof PluginLogger,
      message: string,
      details?: unknown
    ) => void;
    readonly onFailure?: (failure: PluginFailure) => void;
    readonly shutdownTimeoutMs?: number;
  }) {
    this.#state = options.state;
    this.#pluginRcon = createPluginRcon(options.rcon);
    this.#connectors = options.connectors;
    this.#events = options.events;
    this.#logs = options.logs;
    this.#server = options.server ?? { id: 0 };
    this.#logger = options.logger ?? (() => undefined);
    this.#onFailure = options.onFailure ?? (() => undefined);
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    validateDelay(this.#shutdownTimeoutMs);
  }

  async mount<
    Options extends Readonly<Record<string, unknown>>,
    Connectors extends NativeConnectorSchema
  >(
    name: string,
    plugin: Plugin<Options, Connectors>,
    options: Options = {} as Options,
    connectorAliases: Readonly<Record<keyof Connectors & string, string>> = {} as Readonly<
      Record<keyof Connectors & string, string>
    >
  ): Promise<void> {
    if (this.#plugins.some((mounted) => mounted.name === name)) {
      throw new Error(`Plugin is already mounted: ${name}`);
    }
    const resources: OwnedResources = {
      abort: new AbortController(),
      unsubscribers: [],
      timers: new Set(),
      tasks: new Set()
    };
    const logger = this.#scopedLogger(name);
    const track = (task: Promise<unknown>, event = 'background task'): void => {
      const tracked = Promise.resolve(task).then(
        () => undefined,
        (error: unknown) => this.#report(name, event, error)
      );
      resources.tasks.add(tracked);
      void tracked.finally(() => resources.tasks.delete(tracked));
    };
    const run = (handler: () => void | Promise<void>, event: string): void => {
      try {
        const result = handler();
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          track(Promise.resolve(result), event);
        }
      } catch (error) {
        this.#report(name, event, error);
      }
    };
    const context: PluginContext<Options, Connectors> = {
      on: <EventName extends SquadEventName>(
        event: EventName,
        handler: (payload: SquadEventPayload<EventName>) => void | Promise<void>
      ): (() => void) => {
        const unsubscribe = this.#events.subscribe(
          name,
          event,
          handler as (payload: any) => unknown
        );
        resources.unsubscribers.push(unsubscribe);
        return unsubscribe;
      },
      snapshot: () => this.#state.snapshot(),
      connector: (alias) => {
        const connectorName = connectorAliases[alias];
        if (!connectorName)
          throw new Error(`Native plugin ${name} did not declare connector ${alias}`);
        return this.#connectors.get(connectorName) as never;
      },
      optionalConnector: (alias) => {
        const connectorName = connectorAliases[alias];
        return connectorName ? (this.#connectors.optional(connectorName) as never) : undefined;
      },
      setTimeout: (handler, delayMs) => {
        validateDelay(delayMs);
        const timer = setTimeout(() => {
          resources.timers.delete(timer);
          run(handler, 'timeout callback');
        }, delayMs);
        resources.timers.add(timer);
        return () => {
          clearTimeout(timer);
          resources.timers.delete(timer);
        };
      },
      setInterval: (handler, intervalMs) => {
        validateDelay(intervalMs);
        let running = false;
        const timer = setInterval(() => {
          if (running) return;
          running = true;
          const task = Promise.resolve()
            .then(handler)
            .finally(() => {
              running = false;
            });
          track(task, 'interval callback');
        }, intervalMs);
        resources.timers.add(timer);
        return () => {
          clearInterval(timer);
          resources.timers.delete(timer);
        };
      },
      track: (task) => track(task),
      options,
      server: this.#server,
      logs: {
        copyCurrent: (destination, snapshotOptions) => {
          if (!this.#logs) return Promise.reject(new Error('Log snapshots are unavailable'));
          return this.#logs.copySnapshot(destination, {
            ...snapshotOptions,
            signal: resources.abort.signal
          });
        }
      },
      rcon: this.#pluginRcon,
      logger,
      signal: resources.abort.signal
    };
    try {
      await plugin.mount(context);
      this.#plugins.push({ name, plugin: plugin as Plugin, ...resources });
    } catch (error) {
      const cleanupErrors = await this.#release(name, plugin, resources);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Native plugin ${name} failed to mount and cleanup also failed`
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    for (const mounted of [...this.#plugins].reverse()) {
      try {
        await this.unmount(mounted.name);
      } catch (error) {
        errors.push(error);
      }
    }
    await this.#events.drain();
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to stop native plugins');
  }

  async unmount(name: string): Promise<void> {
    const index = this.#plugins.findIndex((mounted) => mounted.name === name);
    if (index < 0) throw new Error(`Plugin is not mounted: ${name}`);
    const [mounted] = this.#plugins.splice(index, 1);
    if (!mounted) throw new Error(`Plugin is not mounted: ${name}`);
    const errors = await this.#release(mounted.name, mounted.plugin, mounted);
    await this.#events.drain();
    if (errors.length > 0) {
      throw new AggregateError(errors, `Native plugin ${name} failed to unmount cleanly`);
    }
  }

  async #release(name: string, plugin: Plugin, resources: OwnedResources): Promise<unknown[]> {
    const errors: unknown[] = [];
    resources.abort.abort();
    for (const timer of resources.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    resources.timers.clear();
    for (const unsubscribe of resources.unsubscribers.splice(0).reverse()) {
      try {
        unsubscribe();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await plugin.unmount?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await waitForTasks(resources.tasks, this.#shutdownTimeoutMs);
    } catch (error) {
      errors.push(error);
    }
    resources.tasks.clear();
    if (errors.length > 0) {
      this.#logger(name, 'error', 'Plugin resource cleanup failed', errors);
    }
    return errors;
  }

  #report(plugin: string, event: string, error: unknown): void {
    const failure = {
      plugin,
      event,
      error: error instanceof Error ? error : new Error(String(error))
    };
    this.#onFailure(failure);
    this.#logger(plugin, 'error', `Plugin callback failed: ${event}`, failure.error);
  }

  #scopedLogger(plugin: string): PluginLogger {
    return {
      debug: (message, details) => this.#logger(plugin, 'debug', message, details),
      info: (message, details) => this.#logger(plugin, 'info', message, details),
      warn: (message, details) => this.#logger(plugin, 'warn', message, details),
      error: (message, details) => this.#logger(plugin, 'error', message, details)
    };
  }
}

function createPluginRcon(rcon: SquadRconClient): PluginRcon {
  return Object.freeze({
    listPlayers: () => rcon.listPlayers(),
    listSquads: () => rcon.listSquads(),
    showCurrentMap: () => rcon.showCurrentMap(),
    showNextMap: () => rcon.showNextMap(),
    showServerInfo: () => rcon.showServerInfo(),
    broadcast: (message: string) => rcon.broadcast(message),
    warn: (eosID: EOSID, message: string) => rcon.warn(eosID, message),
    kick: (eosID: EOSID, reason: string) => rcon.kick(eosID, reason),
    ban: (eosID: EOSID, interval: string, reason: string) => rcon.ban(eosID, interval, reason),
    forceTeamChange: (eosID: EOSID) => rcon.forceTeamChange(eosID)
  });
}

function validateDelay(delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError('Plugin timer delay must be a non-negative finite number');
  }
}

async function waitForTasks(tasks: ReadonlySet<Promise<void>>, timeoutMs: number): Promise<void> {
  if (tasks.size === 0) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([...tasks]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Plugin tasks did not stop within ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function pluginFailureLogger(
  logger: (plugin: string, level: keyof PluginLogger, message: string, details?: unknown) => void
): (failure: PluginFailure) => void {
  return (failure) =>
    logger(failure.plugin, 'error', `Plugin event failed: ${failure.event}`, failure.error);
}
