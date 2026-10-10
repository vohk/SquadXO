import type { EOSID, PlayerIdentity, SteamID } from './identity.js';
import type { Player } from './player.js';

export interface SourceEvent {
  readonly time: Date;
  readonly raw?: string;
  readonly chainID?: number | string;
}

export interface PlayerEvent extends SourceEvent {
  readonly player: Player;
}

export interface PlayerDisconnectedEvent extends SourceEvent {
  readonly eosID: EOSID;
  readonly player?: Player;
}

export interface CombatEvent extends SourceEvent {
  readonly attacker?: Player;
  readonly victim?: Player;
  readonly damage?: number;
  readonly weapon?: string;
  readonly teamkill?: boolean;
}

export interface ReviveEvent extends CombatEvent {
  readonly reviver?: Player;
  readonly woundTime?: Date;
}

export interface RoundTeamResult {
  readonly team: number;
  readonly faction?: string;
  readonly subfaction?: string;
  readonly tickets?: number;
  readonly layer?: string;
  readonly level?: string;
}

export interface RoundEndedEvent extends SourceEvent {
  readonly winner: RoundTeamResult | null;
  readonly loser: RoundTeamResult | null;
}

export interface NewGameEvent extends SourceEvent {
  readonly dlc: string;
  readonly mapClassname: string;
  readonly layerClassname: string;
}

export interface ChatMessageEvent {
  readonly message: string;
  readonly chat: string;
  readonly name?: string;
  readonly eosID?: EOSID;
  readonly steamID?: SteamID;
  readonly raw?: string;
  readonly time?: Date;
  readonly player?: Player;
}

export interface TickRateEvent extends SourceEvent {
  readonly tickRate: number;
}

export interface ServerInformationEvent {
  readonly a2sPlayerCount: number;
  readonly publicQueue: number;
  readonly reserveQueue: number;
  readonly [field: string]: unknown;
}

export interface LegacyConnectionEvent extends SourceEvent {
  readonly eosID?: EOSID;
  readonly steamID?: SteamID;
  readonly ip?: string;
  readonly playerSuffix?: string;
  readonly connection?: string;
  readonly playercontroller?: string;
}

export interface LogLocation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CaptureZoneEvent extends SourceEvent {
  readonly zoneName: string;
  readonly teamID: number;
}

export interface MapMarkerPlacedEvent extends SourceEvent {
  readonly playerName: string;
  readonly playerTeamID: number;
  readonly eosID?: EOSID;
  readonly steamID?: SteamID;
  readonly teamID: number;
  readonly markerType: string;
  readonly location: LogLocation;
}

export interface DeployableSpawnedEvent extends SourceEvent {
  readonly deployable: string;
  readonly teamID: number;
  readonly location: LogLocation;
}

/** Application command audit; transport/authentication packets are never included. */
export interface RconCommandCompletedEvent {
  readonly type: 'command';
  readonly requestID: number;
  readonly command: string;
  readonly requestedAt: Date;
  readonly sentAt?: Date;
  readonly time: Date;
  readonly durationMs: number;
  readonly outcome: 'success' | 'error';
  readonly response?: string;
  readonly error?: { readonly name: string; readonly message: string };
}

export interface RconPushEvent {
  readonly type: 'push';
  readonly time: Date;
  readonly body: string;
}

export type RconAuditEvent = RconCommandCompletedEvent | RconPushEvent;

export interface SquadEventMap {
  ADMIN_BROADCAST: SourceEvent & { readonly message: string; readonly from: string };
  ADDING_CLIENT_CONNECTION: LegacyConnectionEvent;
  CHAT_MESSAGE: ChatMessageEvent;
  CAPTURE_ZONE_CAPTURED: CaptureZoneEvent;
  CAPTURE_ZONE_NEUTRALIZED: CaptureZoneEvent & { readonly previousTeamID: number };
  CLIENT_CONNECTED: LegacyConnectionEvent;
  CLIENT_EXTERNAL_ACCOUNT_INFO: LegacyConnectionEvent;
  CLIENT_JOIN_REQUEST: LegacyConnectionEvent;
  CLIENT_LOGIN: LegacyConnectionEvent;
  CLIENT_LOGIN_REQUEST: LegacyConnectionEvent;
  DEPLOYABLE_SPAWNED: DeployableSpawnedEvent;
  DEPLOYABLE_DAMAGED: SourceEvent & { readonly damage: number; readonly deployable: string };
  JOIN_SUCCEEDED: LegacyConnectionEvent;
  NEW_GAME: NewGameEvent;
  MAP_MARKER_PLACED: MapMarkerPlacedEvent;
  PENDING_CONNECTION_DESTROYED: LegacyConnectionEvent;
  PLAYER_BANNED: unknown;
  PLAYER_CONNECTED: PlayerEvent;
  PLAYER_CONTROLLER_CONNECTED: LegacyConnectionEvent;
  PLAYER_DAMAGED: CombatEvent;
  PLAYER_DIED: CombatEvent & { readonly woundTime?: Date };
  PLAYER_DISCONNECTED: PlayerDisconnectedEvent;
  PLAYER_KICKED: unknown;
  PLAYER_POSSESS: SourceEvent & PlayerIdentity & { readonly possessClassname: string };
  PLAYER_REVIVED: ReviveEvent;
  PLAYER_SQUAD_CHANGE: {
    readonly player: Player;
    readonly oldSquadID?: number;
    readonly newSquadID?: number;
  };
  PLAYER_TEAM_CHANGE: {
    readonly player: Player;
    readonly oldTeamID?: number;
    readonly newTeamID?: number;
  };
  PLAYER_UNPOSSESS: SourceEvent & PlayerIdentity;
  PLAYER_WARNED: unknown;
  PLAYER_WOUNDED: CombatEvent;
  POSSESSED_ADMIN_CAMERA: unknown;
  RAW_LOG_LINE: string;
  RCON_ERROR: unknown;
  RCON_COMMAND_COMPLETED: RconCommandCompletedEvent;
  RCON_PUSH: RconPushEvent;
  RCON_AUDIT_LOG_LINE: string;
  RESOLVED_EOS_ID: LegacyConnectionEvent;
  ROUND_ENDED: RoundEndedEvent;
  SQUAD_CREATED: unknown;
  TEAMKILL: CombatEvent;
  TICK_RATE: TickRateEvent;
  UNPOSSESSED_ADMIN_CAMERA: unknown;
  UPDATED_A2S_INFORMATION: ServerInformationEvent;
  UPDATED_LAYER_INFORMATION: undefined;
  UPDATED_PLAYER_INFORMATION: undefined;
  UPDATED_SERVER_INFORMATION: ServerInformationEvent;
}

export type SquadEventName = keyof SquadEventMap | `CHAT_COMMAND:${string}`;

export type SquadEventPayload<EventName extends SquadEventName> =
  EventName extends keyof SquadEventMap
    ? SquadEventMap[EventName]
    : EventName extends `CHAT_COMMAND:${string}`
      ? ChatMessageEvent
      : never;
