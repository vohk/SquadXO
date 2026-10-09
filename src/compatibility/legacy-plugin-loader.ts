import { pathToFileURL } from 'node:url';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { LegacyServerHost, type LegacyServerFacade } from './legacy-server-facade.js';

export interface LegacyPlugin {
  prepareToMount?(): Promise<void> | void;
  mount?(): Promise<void> | void;
  unmount?(): Promise<void> | void;
}

export interface LegacyPluginConstructor {
  new (
    server: LegacyServerFacade,
    options: Record<string, unknown>,
    connectors: Record<string, unknown>
  ): LegacyPlugin;
  readonly name: string;
  readonly optionsSpecification?: Readonly<
    Record<string, { readonly connector?: string; readonly required?: boolean }>
  >;
}

interface MountedLegacyPlugin {
  readonly name: string;
  readonly plugin: LegacyPlugin;
  readonly facade: LegacyServerFacade;
}

export type LegacyPluginStartupStage = 'constructor' | 'prepare' | 'mount';

export class LegacyPluginStartupError extends Error {
  readonly plugin: string;
  readonly stage: LegacyPluginStartupStage;

  constructor(plugin: string, stage: LegacyPluginStartupStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${plugin}: ${stage} failed: ${detail}`, { cause });
    this.name = 'LegacyPluginStartupError';
    this.plugin = plugin;
    this.stage = stage;
  }
}

export class LegacyPluginLoader {
  readonly #host: LegacyServerHost;
  readonly #connectors: ConnectorRegistry;
  readonly #serverOptions: Readonly<Record<string, unknown>>;
  readonly #mounted: MountedLegacyPlugin[] = [];

  constructor(options: {
    readonly host: LegacyServerHost;
    readonly connectors: ConnectorRegistry;
    readonly serverOptions?: Readonly<Record<string, unknown>>;
  }) {
    this.#host = options.host;
    this.#connectors = options.connectors;
    this.#serverOptions = options.serverOptions ?? {};
  }

  async load(path: string, rawOptions: Record<string, unknown>): Promise<string> {
    const imported = (await import(pathToFileURL(path).href)) as {
      default?: LegacyPluginConstructor;
    };
    if (!imported.default) throw new Error(`Legacy plugin has no default export: ${path}`);
    return this.mount(imported.default, rawOptions);
  }

  async mount(
    PluginClass: LegacyPluginConstructor,
    rawOptions: Record<string, unknown>
  ): Promise<string> {
    return (await this.mountAll([{ PluginClass, rawOptions }]))[0] ?? 'AnonymousLegacyPlugin';
  }

  async mountAll(
    entries: readonly {
      readonly PluginClass: LegacyPluginConstructor;
      readonly rawOptions: Record<string, unknown>;
    }[]
  ): Promise<string[]> {
    const pending: MountedLegacyPlugin[] = [];
    for (const entry of entries) {
      const name = entry.PluginClass.name || 'AnonymousLegacyPlugin';
      const facade = this.#host.createFacade(name, this.#serverOptions);
      try {
        const plugin = new entry.PluginClass(
          facade,
          entry.rawOptions,
          this.#connectors.asLegacyObject()
        );
        const mounted = { name, plugin, facade };
        pending.push(mounted);
        this.#host.registerPlugin(plugin);
      } catch (error) {
        facade.dispose();
        await this.#throwBatchStartupFailure(
          new LegacyPluginStartupError(name, 'constructor', error),
          pending
        );
      }
    }

    for (const entry of pending) {
      try {
        await entry.plugin.prepareToMount?.();
      } catch (error) {
        await this.#throwBatchStartupFailure(
          new LegacyPluginStartupError(entry.name, 'prepare', error),
          pending
        );
      }
    }
    for (const entry of pending) {
      try {
        await entry.plugin.mount?.();
      } catch (error) {
        await this.#throwBatchStartupFailure(
          new LegacyPluginStartupError(entry.name, 'mount', error),
          pending
        );
      }
    }

    this.#mounted.push(...pending);
    return pending.map((entry) => entry.name);
  }

  async stop(): Promise<void> {
    let firstError: unknown;
    for (const mounted of [...this.#mounted].reverse()) {
      try {
        await mounted.plugin.unmount?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        firstError ??= new Error(`${mounted.name}: ${message}`, { cause: error });
      } finally {
        this.#host.unregisterPlugin(mounted.plugin);
        mounted.facade.dispose();
      }
    }
    this.#mounted.length = 0;
    await this.#host.drain();
    if (firstError) throw firstError;
  }

  async #throwBatchStartupFailure(
    startupError: LegacyPluginStartupError,
    pending: readonly MountedLegacyPlugin[]
  ): Promise<never> {
    const cleanupErrors: unknown[] = [];
    for (const entry of [...pending].reverse()) {
      try {
        await entry.plugin.unmount?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        this.#host.unregisterPlugin(entry.plugin);
        entry.facade.dispose();
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        `${startupError.message}; cleanup also failed`
      );
    }
    throw startupError;
  }
}
