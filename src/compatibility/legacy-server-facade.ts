import { EventEmitter } from 'node:events';
import type { EOSID, SteamID } from '../domain/identity.js';
import { ServerState, type LivePlayer } from '../domain/server-state.js';
import type { SquadRconClient } from '../rcon/client.js';
import type { LayerInformation, RconSquad } from '../rcon/squad-protocol.js';
import { knownLayerDisplayName, type LegacyLayer } from './legacy-layer-catalog.js';
import type { ReducedEvent } from '../server/state-reducer.js';
import { adaptLegacyEvent, adaptLegacyPlayer } from './legacy-event-adapter.js';

type LegacyListener = (payload: any) => unknown;

export interface PluginFailure {
  readonly plugin: string;
  readonly event?: string;
  readonly error: Error;
}

export interface LegacyServerOperations {
  readonly refreshPlayers?: () => Promise<void>;
  readonly refreshSquads?: () => Promise<void>;
  readonly refreshAdmins?: () => Promise<void>;
}

export class LegacyServerHost {
  readonly #events = new EventEmitter();
  readonly #pending = new Set<Promise<void>>();
  #roundStartedAt = new Date();
  readonly state: ServerState;
  readonly rcon: SquadRconClient;
  readonly onPluginFailure: (failure: PluginFailure) => void;
  readonly operations: LegacyServerOperations;
  readonly plugins: unknown[] = [];
  #admins: Readonly<Record<string, Readonly<Record<string, true>>>> = {};
  #currentLegacyLayer: LegacyLayer | undefined;
  #nextLegacyLayer: LegacyLayer | undefined;
  #layerHistory: { readonly layer: LegacyLayer; readonly time: Date }[] = [];
  readonly #layerHistoryMaximum = 20;

  constructor(options: {
    readonly state: ServerState;
    readonly rcon: SquadRconClient;
    readonly onPluginFailure?: (failure: PluginFailure) => void;
    readonly operations?: LegacyServerOperations;
  }) {
    this.state = options.state;
    this.rcon = options.rcon;
    this.onPluginFailure = options.onPluginFailure ?? (() => undefined);
    this.operations = options.operations ?? {};
  }

  createFacade(
    plugin: string,
    serverOptions: Readonly<Record<string, unknown>> = {}
  ): LegacyServerFacade {
    return new LegacyServerFacade(this, plugin, serverOptions);
  }

  publish(event: ReducedEvent): void {
    if (event.name === 'NEW_GAME' && event.data.time instanceof Date) {
      this.#roundStartedAt = event.data.time;
    }
    let adapted = adaptLegacyEvent(event, this.state.snapshot().squads);
    if (adapted.name === 'NEW_GAME' && this.#currentLegacyLayer) {
      adapted = { ...adapted, data: { ...adapted.data, layer: this.#currentLegacyLayer } };
    }
    this.#events.emit(adapted.name, adapted.data);
    if (adapted.name === 'PLAYER_WOUNDED' && adapted.data.teamkill === true) {
      this.#events.emit('TEAMKILL', adapted.data);
    }
    if (adapted.name === 'CHAT_MESSAGE') {
      const message = typeof adapted.data.message === 'string' ? adapted.data.message : '';
      const command = message.match(/^!([^ ]+)\s?(.*)$/);
      if (command?.[1]) {
        this.#events.emit(`CHAT_COMMAND:${command[1].toLowerCase()}`, {
          ...adapted.data,
          message: command[2]?.trim() ?? ''
        });
      }
    }
  }

  emit(name: string, payload: unknown): boolean {
    return this.#events.emit(name, payload);
  }

  registerPlugin(plugin: unknown): void {
    if (!this.plugins.includes(plugin)) this.plugins.push(plugin);
  }

  unregisterPlugin(plugin: unknown): void {
    const index = this.plugins.indexOf(plugin);
    if (index !== -1) this.plugins.splice(index, 1);
  }

  get admins(): Readonly<Record<string, Readonly<Record<string, true>>>> {
    return this.#admins;
  }

  replaceAdmins(admins: Readonly<Record<string, Readonly<Record<string, true>>>>): void {
    this.#admins = Object.fromEntries(
      Object.entries(admins).map(([id, permissions]) => [id, { ...permissions }])
    );
  }

  setLegacyLayers(current: LegacyLayer | undefined, next: LegacyLayer | undefined): void {
    this.#currentLegacyLayer = current ? normalizeLegacyLayer(current) : undefined;
    this.#nextLegacyLayer = next ? normalizeLegacyLayer(next) : undefined;
    if (this.#currentLegacyLayer && this.#layerHistory.length === 0) {
      this.recordLegacyLayer(this.#currentLegacyLayer, new Date());
    }
  }

  recordLegacyLayer(layer: LegacyLayer, time: Date): void {
    const normalized = normalizeLegacyLayer(layer);
    this.#currentLegacyLayer = normalized;
    this.#layerHistory.unshift({ layer: { ...normalized }, time: new Date(time) });
    this.#layerHistory = this.#layerHistory.slice(0, this.#layerHistoryMaximum);
  }

  get currentLegacyLayer(): LegacyLayer | undefined {
    return this.#currentLegacyLayer ? { ...this.#currentLegacyLayer } : undefined;
  }

  get nextLegacyLayer(): LegacyLayer | undefined {
    return this.#nextLegacyLayer ? { ...this.#nextLegacyLayer } : undefined;
  }

  get layerHistory(): readonly { readonly layer: LegacyLayer; readonly time: Date }[] {
    return this.#layerHistory.map((entry) => ({
      layer: { ...entry.layer },
      time: new Date(entry.time)
    }));
  }

  get roundStartedAt(): Date {
    return new Date(this.#roundStartedAt);
  }

  subscribe(plugin: string, event: string, listener: LegacyListener): () => void {
    const wrapped = (payload: unknown): void => {
      try {
        const result = listener(payload);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          const pending = Promise.resolve(result).then(
            () => undefined,
            (error: unknown) => this.#report(plugin, event, error)
          );
          this.#pending.add(pending);
          void pending.finally(() => this.#pending.delete(pending));
        }
      } catch (error) {
        this.#report(plugin, event, error);
      }
    };
    this.#events.on(event, wrapped);
    return () => this.#events.off(event, wrapped);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#pending]);
  }

  #report(plugin: string, event: string, error: unknown): void {
    this.onPluginFailure({
      plugin,
      event,
      error: error instanceof Error ? error : new Error(String(error))
    });
  }
}

export class LegacyServerFacade {
  readonly #host: LegacyServerHost;
  readonly #plugin: string;
  readonly #subscriptions = new Map<string, Map<LegacyListener, Set<() => void>>>();
  readonly options: Readonly<Record<string, unknown>>;
  readonly rcon: LegacyRconFacade;
  declare readonly id: unknown;
  declare readonly admins: Readonly<Record<string, Readonly<Record<string, true>>>>;
  declare readonly players: readonly Readonly<Record<string, unknown>>[];
  declare readonly squads: readonly RconSquad[];
  declare readonly currentLayer: Readonly<Record<string, unknown>> | undefined;
  declare readonly nextLayer: Readonly<Record<string, unknown>> | undefined;
  declare readonly nextLayerToBeVoted: boolean;
  declare readonly layerHistory: readonly {
    readonly layer: Readonly<Record<string, unknown>>;
    readonly time: Date;
  }[];
  declare readonly serverName: string | undefined;
  declare readonly maxPlayers: number;
  declare readonly reserveSlots: number;
  declare readonly publicSlots: number;
  declare readonly a2sPlayerCount: number;
  declare readonly playerCount: number;
  declare readonly publicQueue: number;
  declare readonly reserveQueue: number;
  declare readonly matchTimeout: number;
  declare readonly matchStartTime: Date;
  declare readonly gameVersion: string | undefined;
  declare readonly plugins: readonly unknown[];

  constructor(host: LegacyServerHost, plugin: string, options: Readonly<Record<string, unknown>>) {
    this.#host = host;
    this.#plugin = plugin;
    this.options = options;
    this.rcon = new LegacyRconFacade(host.rcon);
    Object.defineProperties(this, {
      id: legacyGetter(() => this.options.id),
      admins: legacyGetter(() => this.#host.admins),
      players: legacyGetter(() => {
        const snapshot = this.#host.state.snapshot();
        return snapshot.players.map((player) => adaptLegacyPlayer(player, snapshot.squads));
      }),
      squads: legacyGetter(() => this.#host.state.snapshot().squads),
      currentLayer: legacyGetter(() => {
        if (this.#host.currentLegacyLayer) return this.#host.currentLegacyLayer;
        const snapshot = this.#host.state.snapshot();
        return legacyLayer(snapshot.currentLayer, snapshot.serverInfo.MapName_s);
      }),
      nextLayer: legacyGetter(() => {
        if (this.#host.nextLegacyLayer) return this.#host.nextLegacyLayer;
        const snapshot = this.#host.state.snapshot();
        return legacyLayer(snapshot.nextLayer, snapshot.serverInfo.NextLayer_s);
      }),
      nextLayerToBeVoted: legacyGetter(() => this.nextLayer?.name === undefined),
      layerHistory: legacyGetter(() => this.#host.layerHistory),
      serverName: legacyGetter(() => this.#serverString('serverName', 'ServerName_s')),
      maxPlayers: legacyGetter(() => this.#serverNumber('maxPlayers', 'MaxPlayers') ?? 0),
      reserveSlots: legacyGetter(
        () => this.#serverNumber('reserveSlots', 'PlayerReserveCount_I') ?? 0
      ),
      publicSlots: legacyGetter(() => Math.max(0, this.maxPlayers - this.reserveSlots)),
      a2sPlayerCount: legacyGetter(
        () => this.#serverNumber('a2sPlayerCount', 'PlayerCount_I') ?? this.players.length
      ),
      playerCount: legacyGetter(
        () => this.#serverNumber('playerCount', 'PlayerCount_I') ?? this.players.length
      ),
      publicQueue: legacyGetter(() => this.#serverNumber('publicQueue', 'PublicQueue_I') ?? 0),
      reserveQueue: legacyGetter(() => this.#serverNumber('reserveQueue', 'ReservedQueue_I') ?? 0),
      matchTimeout: legacyGetter(() => this.#serverNumber('matchTimeout', 'MatchTimeout_d') ?? 0),
      matchStartTime: legacyGetter(() => {
        const playtime = this.#serverNumber('playtime', 'PLAYTIME_I');
        return playtime === undefined
          ? this.#host.roundStartedAt
          : new Date(Date.now() - playtime * 1000);
      }),
      gameVersion: legacyGetter(() => this.#serverString('gameVersion', 'GameVersion_s')),
      plugins: legacyGetter(() => this.#host.plugins)
    });
  }

  on(event: string, listener: LegacyListener): this {
    const unsubscribe = this.#host.subscribe(this.#plugin, event, listener);
    this.#trackSubscription(event, listener, unsubscribe);
    return this;
  }

  once(event: string, listener: LegacyListener): this {
    let unsubscribe = (): void => undefined;
    const onceListener = (payload: unknown): unknown => {
      unsubscribe();
      this.#forgetSubscription(event, listener, unsubscribe);
      return listener(payload);
    };
    unsubscribe = this.#host.subscribe(this.#plugin, event, onceListener);
    this.#trackSubscription(event, listener, unsubscribe);
    return this;
  }

  off(event: string, listener: LegacyListener): this {
    const listeners = this.#subscriptions.get(event);
    for (const unsubscribe of listeners?.get(listener) ?? []) unsubscribe();
    listeners?.delete(listener);
    if (listeners?.size === 0) this.#subscriptions.delete(event);
    return this;
  }

  removeEventListener(event: string, listener: LegacyListener): this {
    return this.off(event, listener);
  }

  emit(event: string, payload: unknown): boolean {
    return this.#host.emit(event, payload);
  }

  dispose(): void {
    for (const listeners of this.#subscriptions.values()) {
      for (const subscriptions of listeners.values()) {
        for (const unsubscribe of subscriptions) unsubscribe();
      }
    }
    this.#subscriptions.clear();
  }

  #trackSubscription(event: string, listener: LegacyListener, unsubscribe: () => void): void {
    const listeners = this.#subscriptions.get(event) ?? new Map();
    const subscriptions = listeners.get(listener) ?? new Set();
    subscriptions.add(unsubscribe);
    listeners.set(listener, subscriptions);
    this.#subscriptions.set(event, listeners);
  }

  #forgetSubscription(event: string, listener: LegacyListener, unsubscribe: () => void): void {
    const listeners = this.#subscriptions.get(event);
    const subscriptions = listeners?.get(listener);
    subscriptions?.delete(unsubscribe);
    if (subscriptions?.size === 0) listeners?.delete(listener);
    if (listeners?.size === 0) this.#subscriptions.delete(event);
  }

  async getPlayerByEOSID(
    eosID: EOSID,
    forceUpdate = false
  ): Promise<Readonly<Record<string, unknown>> | null> {
    return this.getPlayerByCondition((player) => player.eosID === eosID, forceUpdate);
  }

  async getPlayerBySteamID(
    steamID: SteamID,
    forceUpdate = false
  ): Promise<Readonly<Record<string, unknown>> | null> {
    return this.getPlayerByCondition((player) => player.steamID === steamID, forceUpdate);
  }

  async getPlayerByAnyID(
    id: EOSID | SteamID,
    forceUpdate = false
  ): Promise<Readonly<Record<string, unknown>> | null> {
    return this.getPlayerByCondition(
      (player) => player.eosID === id || player.steamID === id,
      forceUpdate
    );
  }

  async getPlayerByName(
    name: string,
    forceUpdate = false
  ): Promise<Readonly<Record<string, unknown>> | null> {
    return this.getPlayerByCondition((player) => player.name === name, forceUpdate);
  }

  async getPlayerByNameSuffix(
    suffix: string,
    forceUpdate = false
  ): Promise<Readonly<Record<string, unknown>> | null> {
    if (forceUpdate) await this.updatePlayerList();
    return this.#optionalLegacyPlayer(this.#host.state.getPlayerByNameSuffix(suffix));
  }

  async getPlayerByController(
    controller: string,
    forceUpdate = false
  ): Promise<Readonly<Record<string, unknown>> | null> {
    return this.getPlayerByCondition(
      (player) => player.playercontroller === controller,
      forceUpdate
    );
  }

  async getSquadByID(teamID: number, squadID: number | null): Promise<RconSquad | null> {
    if (squadID === null) return null;
    return this.getSquadByCondition(
      (squad) => squad.teamID === teamID && squad.squadID === squadID
    );
  }

  getAdminPermsByAnyID(anyID: string): Readonly<Record<string, unknown>> | undefined {
    const direct = this.admins[anyID];
    if (isRecord(direct)) return direct;
    const player = this.players.find(
      (candidate) => candidate.eosID === anyID || candidate.steamID === anyID
    );
    if (!player) return undefined;
    const mapped = [player.eosID, player.steamID]
      .filter((id): id is string => typeof id === 'string')
      .map((id) => this.admins[id])
      .find(isRecord);
    return mapped;
  }

  getAdminPermsBySteamID(steamID: string): Readonly<Record<string, unknown>> | undefined {
    return this.getAdminPermsByAnyID(steamID);
  }

  getAdminsWithPermission(permission: string, type: string = 'steamID'): unknown[] {
    const matchingIDs = Object.entries(this.admins)
      .filter(([, permissions]) => isRecord(permissions) && permission in permissions)
      .map(([id]) => id);
    const players = this.players.filter((player) =>
      matchingIDs.some((id) => player.eosID === id || player.steamID === id)
    );
    if (type === 'anyID') {
      return [
        ...new Set(
          matchingIDs.map((id) => {
            const player = players.find(
              (candidate) => candidate.eosID === id || candidate.steamID === id
            );
            return typeof player?.eosID === 'string' ? player.eosID : id;
          })
        )
      ];
    }
    if (type === 'player') return players;
    if (type !== 'steamID' && type !== 'eosID') {
      throw new Error(`Expected type == 'steamID'|'eosID'|'anyID'|'player', got '${type}'.`);
    }
    const mapped = players
      .map((player) => player[type])
      .filter((id): id is string => typeof id === 'string');
    const direct = matchingIDs.filter((id) =>
      type === 'steamID' ? /^\d{17}$/.test(id) : /^[0-9a-f]{32}$/i.test(id)
    );
    return [...new Set([...direct, ...mapped])];
  }

  async updatePlayerList(): Promise<void> {
    if (this.#host.operations.refreshPlayers) {
      await this.#host.operations.refreshPlayers();
      return;
    }
    this.#host.state.replacePlayers(await this.#host.rcon.listPlayers());
  }

  async updateSquadList(): Promise<void> {
    if (this.#host.operations.refreshSquads) {
      await this.#host.operations.refreshSquads();
      return;
    }
    this.#host.state.replaceSquads(await this.#host.rcon.listSquads());
  }

  async updateAdmins(): Promise<void> {
    await this.#host.operations.refreshAdmins?.();
  }

  async getPlayerByCondition(
    condition: (player: Readonly<Record<string, unknown>>) => boolean,
    forceUpdate = false,
    retry = true
  ): Promise<Readonly<Record<string, unknown>> | null> {
    if (!forceUpdate) {
      const matches = this.players.filter(condition);
      if (matches.length === 1) return matches[0] ?? null;
      if (!retry) return null;
    }
    await this.updatePlayerList();
    const matches = this.players.filter(condition);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  async getSquadByCondition(
    condition: (squad: RconSquad) => boolean,
    forceUpdate = false,
    retry = false
  ): Promise<RconSquad | null> {
    if (!forceUpdate) {
      const matches = this.squads.filter(condition);
      if (matches.length === 1) return matches[0] ?? null;
      if (!retry) return null;
    }
    await this.updateSquadList();
    const matches = this.squads.filter(condition);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  #optionalLegacyPlayer(player: LivePlayer | undefined): Readonly<Record<string, unknown>> | null {
    return player ? adaptLegacyPlayer(player, this.#host.state.snapshot().squads) : null;
  }

  #serverNumber(...keys: string[]): number | undefined {
    const info = this.#host.state.snapshot().serverInfo;
    for (const key of keys) {
      const value = info[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  }

  #serverString(...keys: string[]): string | undefined {
    const info = this.#host.state.snapshot().serverInfo;
    for (const key of keys) {
      const value = info[key];
      if (typeof value === 'string') return value;
    }
    return undefined;
  }
}

export class LegacyRconFacade {
  constructor(
    readonly client: SquadRconClient,
    readonly broadcastRecoveryWaitMs = 5_000
  ) {}

  execute(command: string): Promise<string> {
    return this.client.execute(command);
  }

  async broadcast(message: string): Promise<void> {
    try {
      await this.client.broadcast(message);
    } catch (error) {
      if (this.client.state === 'ready') throw error;
      await waitForRconReady(this.client, this.broadcastRecoveryWaitMs);
      await this.client.broadcast(message);
    }
  }

  warn(eosID: EOSID, message: string): Promise<void> {
    return this.client.warn(eosID, message);
  }

  kick(eosID: EOSID, reason: string): Promise<void> {
    return this.client.kick(eosID, reason);
  }

  ban(eosID: EOSID, interval: string, reason: string): Promise<void> {
    return this.client.ban(eosID, interval, reason);
  }

  forceTeamChange(eosID: EOSID): Promise<void> {
    return this.client.forceTeamChange(eosID);
  }

  switchTeam(eosID: EOSID): Promise<void> {
    return this.client.forceTeamChange(eosID);
  }

  async setFogOfWar(mode: number): Promise<void> {
    await this.client.execute(`AdminSetFogOfWar ${mode}`);
  }

  getListPlayers(): ReturnType<SquadRconClient['listPlayers']> {
    return this.client.listPlayers();
  }

  getSquads(): ReturnType<SquadRconClient['listSquads']> {
    return this.client.listSquads();
  }

  getCurrentMap(): ReturnType<SquadRconClient['showCurrentMap']> {
    return this.client.showCurrentMap();
  }

  getNextMap(): ReturnType<SquadRconClient['showNextMap']> {
    return this.client.showNextMap();
  }
}

function waitForRconReady(client: SquadRconClient, timeoutMs: number): Promise<void> {
  if (client.state === 'ready') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off('state', onState);
    };
    const onState = (): void => {
      if (client.state === 'ready') {
        cleanup();
        resolve();
      } else if (client.state === 'stopping') {
        cleanup();
        reject(new Error('RCON stopped before the legacy broadcast could be sent'));
      }
    };
    client.on('state', onState);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`RCON did not recover within ${timeoutMs}ms for a legacy broadcast`));
    }, timeoutMs);
    onState();
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function legacyGetter<T>(get: () => T): PropertyDescriptor {
  return { configurable: false, enumerable: true, get };
}

function legacyLayer(
  layer: LayerInformation | undefined,
  fallback: unknown
): Readonly<Record<string, unknown>> | undefined {
  const identifier = layer?.layer ?? fallback;
  if (typeof identifier !== 'string' || !identifier) return layer ? { ...layer } : undefined;
  const name = knownLayerDisplayName(identifier) ?? identifier;
  return {
    ...layer,
    name,
    layerid: layer?.layer ?? name,
    classname: layer?.level ?? name,
    map: { name: layer?.level ?? name },
    teams: []
  };
}

function normalizeLegacyLayer(layer: LegacyLayer): LegacyLayer {
  const map = isRecord(layer.map) ? layer.map : undefined;
  const name = [layer.layerid, layer.classname, layer.name, map?.name]
    .map(knownLayerDisplayName)
    .find(Boolean);
  return name ? { ...layer, name } : { ...layer };
}
