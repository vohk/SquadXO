import type { PlayerSnapshotChanges, ServerState } from '../domain/server-state.js';
import type { LayerInformation, RconPlayer, RconSquad } from '../rcon/squad-protocol.js';
import { normalizeServerInformation } from '../rcon/squad-protocol.js';
import type { ServerInformationEvent } from '../domain/events.js';
import { NonOverlappingScheduler } from './scheduler.js';

export interface SnapshotRcon {
  listPlayers(): Promise<RconPlayer[]>;
  listSquads(): Promise<RconSquad[]>;
  showCurrentMap(): Promise<LayerInformation>;
  showNextMap(): Promise<LayerInformation>;
  showServerInfo(): Promise<Readonly<Record<string, unknown>>>;
}

export interface StateRefreshIntervals {
  readonly playersMs?: number;
  readonly squadsMs?: number;
  readonly layersMs?: number;
  readonly serverInfoMs?: number;
}

export interface StateRefreshHooks {
  readonly players?: (changes: PlayerSnapshotChanges) => void;
  readonly squads?: () => void;
  readonly layers?: (current: LayerInformation, next: LayerInformation) => void | Promise<void>;
  readonly serverInfo?: (information: ServerInformationEvent) => void;
}

export class StateRefresher {
  readonly scheduler = new NonOverlappingScheduler();
  readonly #state: ServerState;
  readonly #rcon: SnapshotRcon;
  readonly #hooks: StateRefreshHooks;
  #playerRefresh: Promise<void> | undefined;

  constructor(
    state: ServerState,
    rcon: SnapshotRcon,
    intervals: StateRefreshIntervals = {},
    hooks: StateRefreshHooks = {}
  ) {
    this.#state = state;
    this.#rcon = rcon;
    this.#hooks = hooks;
    this.scheduler.add('players', intervals.playersMs ?? 5_000, () => this.refreshPlayers());
    this.scheduler.add('squads', intervals.squadsMs ?? 30_000, () => this.refreshSquads());
    this.scheduler.add('layers', intervals.layersMs ?? 30_000, () => this.refreshLayers());
    this.scheduler.add('serverInfo', intervals.serverInfoMs ?? 5_000, () =>
      this.refreshServerInfo()
    );
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.refreshPlayers(),
      this.refreshSquads(),
      this.refreshLayers(true),
      this.refreshServerInfo()
    ]);
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): Promise<void> {
    return this.scheduler.stop();
  }

  refreshPlayers(): Promise<void> {
    if (this.#playerRefresh) return this.#playerRefresh;
    const refresh = (async () => {
      const changes = this.#state.replacePlayers(await this.#rcon.listPlayers());
      this.#hooks.players?.(changes);
    })();
    this.#playerRefresh = refresh;
    const clearRefresh = (): void => {
      if (this.#playerRefresh === refresh) this.#playerRefresh = undefined;
    };
    void refresh.then(clearRefresh, clearRefresh);
    return refresh;
  }

  async refreshSquads(): Promise<void> {
    this.#state.replaceSquads(await this.#rcon.listSquads());
    this.#hooks.squads?.();
  }

  async refreshLayers(allowUnavailableNext = false): Promise<void> {
    const current = await this.#rcon.showCurrentMap();
    let next: LayerInformation;
    try {
      next = await this.#rcon.showNextMap();
    } catch (error) {
      const unavailableNext = unavailableLayer();
      this.#state.setLayers(current, unavailableNext);
      await this.#hooks.layers?.(current, unavailableNext);
      if (!allowUnavailableNext) throw error;
      return;
    }
    this.#state.setLayers(current, next);
    await this.#hooks.layers?.(current, next);
  }

  async refreshServerInfo(): Promise<void> {
    const information = normalizeServerInformation(await this.#rcon.showServerInfo());
    this.#state.setServerInfo(information);
    this.#hooks.serverInfo?.(information);
  }
}

function unavailableLayer(): LayerInformation {
  return { level: null, layer: null, team1Faction: null, team2Faction: null };
}
