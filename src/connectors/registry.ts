export type ConnectorMap = Readonly<Record<string, unknown>>;

export class ConnectorRegistry {
  readonly #connectors: ConnectorMap;

  constructor(connectors: ConnectorMap = {}) {
    this.#connectors = { ...connectors };
  }

  get(name: string): unknown {
    if (!(name in this.#connectors)) throw new Error(`Connector is not configured: ${name}`);
    return this.#connectors[name];
  }

  optional(name: string): unknown {
    return this.#connectors[name];
  }

  asLegacyObject(): Record<string, unknown> {
    return { ...this.#connectors };
  }
}
