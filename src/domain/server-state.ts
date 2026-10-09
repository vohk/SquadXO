import type { EOSID, SteamID } from './identity.js';
import type { Player } from './player.js';
import type { LayerInformation, RconPlayer, RconSquad } from '../rcon/squad-protocol.js';

export interface LivePlayer extends Player {
  readonly playerID?: number;
  readonly isLeader?: boolean;
  readonly controller?: string;
  readonly suffix?: string;
  readonly possessClassname?: string;
  readonly ip?: string;
}

export interface ServerStateSnapshot {
  readonly players: readonly LivePlayer[];
  readonly squads: readonly RconSquad[];
  readonly currentLayer?: LayerInformation;
  readonly nextLayer?: LayerInformation;
  readonly serverInfo: Readonly<Record<string, unknown>>;
}

export interface PlayerSnapshotChanges {
  readonly connected: readonly LivePlayer[];
  readonly disconnected: readonly LivePlayer[];
  readonly teamChanged: readonly {
    readonly player: LivePlayer;
    readonly oldTeamID?: number;
    readonly newTeamID?: number;
  }[];
  readonly squadChanged: readonly {
    readonly player: LivePlayer;
    readonly oldSquadID?: number;
    readonly newSquadID?: number;
  }[];
}

export class ServerState {
  readonly #players = new Map<EOSID, LivePlayer>();
  readonly #departedPlayers = new Map<
    EOSID,
    { readonly player: LivePlayer; readonly expiresAt: number }
  >();
  readonly #departedPlayerTtlMs: number;
  readonly #now: () => number;
  #squads: RconSquad[] = [];
  #currentLayer: LayerInformation | undefined;
  #nextLayer: LayerInformation | undefined;
  #serverInfo: Readonly<Record<string, unknown>> = {};

  constructor(
    options: { readonly departedPlayerTtlMs?: number; readonly now?: () => number } = {}
  ) {
    this.#departedPlayerTtlMs = options.departedPlayerTtlMs ?? 120_000;
    this.#now = options.now ?? Date.now;
  }

  snapshot(): ServerStateSnapshot {
    return {
      players: [...this.#players.values()].map((player) => ({ ...player })),
      squads: this.#squads.map((squad) => ({ ...squad })),
      ...(this.#currentLayer ? { currentLayer: { ...this.#currentLayer } } : {}),
      ...(this.#nextLayer ? { nextLayer: { ...this.#nextLayer } } : {}),
      serverInfo: { ...this.#serverInfo }
    };
  }

  upsertPlayer(player: LivePlayer): LivePlayer {
    const merged = { ...this.#players.get(player.eosID), ...player };
    this.#players.set(player.eosID, merged);
    this.#departedPlayers.delete(player.eosID);
    return { ...merged };
  }

  disconnectPlayer(eosID: EOSID): LivePlayer | undefined {
    const player = this.#players.get(eosID);
    this.#players.delete(eosID);
    if (player) {
      this.#rememberDeparted(player);
      return { ...player };
    }
    return this.#recentlyDeparted(eosID);
  }

  replacePlayers(players: readonly RconPlayer[]): PlayerSnapshotChanges {
    const previous = new Map(this.#players);
    const next = new Map<EOSID, LivePlayer>();
    const connected: LivePlayer[] = [];
    const teamChanged: { player: LivePlayer; oldTeamID?: number; newTeamID?: number }[] = [];
    const squadChanged: { player: LivePlayer; oldSquadID?: number; newSquadID?: number }[] = [];

    for (const rconPlayer of players) {
      const oldPlayer = previous.get(rconPlayer.eosID);
      const {
        teamID: _oldTeamID,
        squadID: _oldSquadID,
        partyID: _oldPartyID,
        vehicle: _oldVehicle,
        role: _oldRole,
        playerID: _oldPlayerID,
        isLeader: _oldIsLeader,
        ...retained
      } = oldPlayer ?? { eosID: rconPlayer.eosID, name: rconPlayer.name };
      const player: LivePlayer = {
        ...retained,
        eosID: rconPlayer.eosID,
        ...(rconPlayer.steamID ? { steamID: rconPlayer.steamID } : {}),
        name: rconPlayer.name,
        ...(rconPlayer.teamID === null ? {} : { teamID: rconPlayer.teamID }),
        ...(rconPlayer.squadID === null ? {} : { squadID: rconPlayer.squadID }),
        ...(rconPlayer.partyID === undefined ? {} : { partyID: rconPlayer.partyID }),
        ...(rconPlayer.vehicle === undefined ? {} : { vehicle: rconPlayer.vehicle }),
        role: rconPlayer.role,
        playerID: rconPlayer.playerID,
        isLeader: rconPlayer.isLeader
      };
      next.set(player.eosID, player);
      this.#departedPlayers.delete(player.eosID);
      if (!oldPlayer) connected.push({ ...player });
      if (oldPlayer && oldPlayer.teamID !== player.teamID) {
        teamChanged.push({
          player: { ...player },
          ...(oldPlayer?.teamID === undefined ? {} : { oldTeamID: oldPlayer.teamID }),
          ...(player.teamID === undefined ? {} : { newTeamID: player.teamID })
        });
      }
      if (oldPlayer && oldPlayer.squadID !== player.squadID) {
        squadChanged.push({
          player: { ...player },
          ...(oldPlayer?.squadID === undefined ? {} : { oldSquadID: oldPlayer.squadID }),
          ...(player.squadID === undefined ? {} : { newSquadID: player.squadID })
        });
      }
    }

    const disconnected = [...previous.entries()]
      .filter(([eosID]) => !next.has(eosID))
      .map(([, player]) => ({ ...player }));
    for (const player of disconnected) this.#rememberDeparted(player);
    this.#players.clear();
    for (const [eosID, player] of next) this.#players.set(eosID, player);
    return { connected, disconnected, teamChanged, squadChanged };
  }

  replaceSquads(squads: readonly RconSquad[]): void {
    this.#squads = squads.map((squad) => ({ ...squad }));
  }

  setLayers(currentLayer: LayerInformation, nextLayer: LayerInformation): void {
    this.#currentLayer = { ...currentLayer };
    this.#nextLayer = { ...nextLayer };
  }

  setServerInfo(serverInfo: Readonly<Record<string, unknown>>): void {
    this.#serverInfo = { ...serverInfo };
  }

  getPlayerByEOSID(eosID: EOSID): LivePlayer | undefined {
    const player = this.#players.get(eosID);
    return player ? { ...player } : undefined;
  }

  getPlayerBySteamID(steamID: SteamID): LivePlayer | undefined {
    return this.#findPlayer((player) => player.steamID === steamID);
  }

  getPlayerByName(name: string): LivePlayer | undefined {
    const normalized = name.toLocaleLowerCase();
    return this.#findPlayer((player) => player.name.toLocaleLowerCase() === normalized);
  }

  getPlayerByController(controller: string): LivePlayer | undefined {
    return this.#findPlayer((player) => player.controller === controller);
  }

  getPlayerByNameSuffix(suffix: string): LivePlayer | undefined {
    return (
      this.#findPlayer((player) => player.suffix === suffix) ??
      this.#findPlayer((player) => player.name === suffix)
    );
  }

  #findPlayer(predicate: (player: LivePlayer) => boolean): LivePlayer | undefined {
    const player = [...this.#players.values()].find(predicate);
    return player ? { ...player } : undefined;
  }

  #rememberDeparted(player: LivePlayer): void {
    this.#pruneDeparted();
    this.#departedPlayers.set(player.eosID, {
      player: { ...player },
      expiresAt: this.#now() + this.#departedPlayerTtlMs
    });
  }

  #recentlyDeparted(eosID: EOSID): LivePlayer | undefined {
    this.#pruneDeparted();
    const entry = this.#departedPlayers.get(eosID);
    return entry ? { ...entry.player } : undefined;
  }

  #pruneDeparted(): void {
    const now = this.#now();
    for (const [eosID, entry] of this.#departedPlayers) {
      if (entry.expiresAt <= now) this.#departedPlayers.delete(eosID);
    }
  }
}
