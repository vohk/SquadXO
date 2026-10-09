import type { LivePlayer } from '../domain/server-state.js';
import type { ReducedEvent } from '../server/state-reducer.js';
import type { CombatWrite, DbLog, MatchEnd, MatchStart } from './db-log.js';

export type DbLogWriter = Pick<
  DbLog,
  'playerConnected' | 'startMatch' | 'endMatch' | 'tickRate' | 'wound' | 'death' | 'revive'
>;

export interface DbLogEventContext {
  readonly layer?: Readonly<Record<string, unknown>>;
}

export interface ResolvedMatchMetadata {
  readonly map?: string;
  readonly layer?: string;
}

export class DbLogEventBridge {
  readonly #dbLog: DbLogWriter;
  readonly #onError: (error: Error) => void;

  constructor(dbLog: DbLogWriter, onError: (error: Error) => void = () => undefined) {
    this.#dbLog = dbLog;
    this.#onError = onError;
  }

  handle(event: ReducedEvent, context: DbLogEventContext = {}): void {
    const data = event.data;
    let write: Promise<void> | undefined;
    switch (event.name) {
      case 'PLAYER_CONNECTED': {
        const player = livePlayer(data.player);
        if (player) write = this.#dbLog.playerConnected(player);
        break;
      }
      case 'NEW_GAME':
        write = this.#dbLog.startMatch(matchStart(data, context.layer));
        break;
      case 'ROUND_ENDED':
        write = this.#dbLog.endMatch(matchEnd(data));
        break;
      case 'TICK_RATE': {
        const tickRate = number(data.tickRate);
        if (tickRate !== undefined) write = this.#dbLog.tickRate(date(data.time), tickRate);
        break;
      }
      case 'PLAYER_WOUNDED': {
        const combat = combatWrite(data);
        if (combat) write = this.#dbLog.wound(combat);
        break;
      }
      case 'PLAYER_DIED': {
        const combat = combatWrite(data);
        if (combat) write = this.#dbLog.death(combat);
        break;
      }
      case 'PLAYER_REVIVED': {
        const combat = combatWrite(data);
        const reviver = livePlayer(data.reviver);
        if (combat && reviver) write = this.#dbLog.revive({ ...combat, reviver });
        break;
      }
    }
    void write?.catch((error: unknown) =>
      this.#onError(error instanceof Error ? error : new Error(String(error)))
    );
  }
}

function matchStart(
  data: Readonly<Record<string, unknown>>,
  resolvedLayer: Readonly<Record<string, unknown>> | undefined
): MatchStart {
  const resolved = resolvedMatchMetadata(resolvedLayer);
  return {
    time: date(data.time),
    ...optionalStringFields(data, ['dlc', 'mapClassname', 'layerClassname', 'map', 'layer']),
    ...resolved
  };
}

export function resolvedMatchMetadata(
  resolvedLayer: Readonly<Record<string, unknown>> | undefined
): ResolvedMatchMetadata {
  const map = record(resolvedLayer?.map);
  const resolvedMap = string(map?.name);
  const resolvedName = string(resolvedLayer?.name);
  return {
    ...(resolvedMap ? { map: resolvedMap } : {}),
    ...(resolvedName ? { layer: resolvedName } : {})
  };
}

function matchEnd(data: Readonly<Record<string, unknown>>): MatchEnd {
  const winner = record(data.winner);
  const loser = record(data.loser);
  const team1 = winner?.team === 1 ? winner : loser?.team === 1 ? loser : undefined;
  const team2 = winner?.team === 2 ? winner : loser?.team === 2 ? loser : undefined;
  return {
    time: date(data.time),
    ...(number(winner?.team) === undefined ? {} : { winnerTeam: number(winner?.team) }),
    ...teamFields(team1, 'team1'),
    ...teamFields(team2, 'team2')
  } as MatchEnd;
}

function combatWrite(data: Readonly<Record<string, unknown>>): CombatWrite | undefined {
  const victim = livePlayer(data.victim);
  if (!victim) return undefined;
  const attacker = livePlayer(data.attacker);
  return {
    time: date(data.time),
    ...(data.woundTime === undefined ? {} : { woundTime: date(data.woundTime) }),
    victim,
    ...(attacker ? { attacker } : {}),
    ...(number(data.damage) === undefined ? {} : { damage: number(data.damage) }),
    ...(string(data.weapon) === undefined ? {} : { weapon: string(data.weapon) }),
    ...(typeof data.teamkill === 'boolean' ? { teamkill: data.teamkill } : {})
  } as CombatWrite;
}

function teamFields(
  team: Readonly<Record<string, unknown>> | undefined,
  prefix: 'team1' | 'team2'
): Partial<MatchEnd> {
  if (!team) return {};
  const faction = string(team.faction);
  const unit = string(team.subfaction);
  const tickets = number(team.tickets);
  return {
    ...(faction ? { [`${prefix}Faction`]: faction } : {}),
    ...(unit ? { [`${prefix}Unit`]: unit } : {}),
    ...(tickets === undefined ? {} : { [`${prefix}Tickets`]: tickets })
  };
}

function optionalStringFields(
  data: Readonly<Record<string, unknown>>,
  fields: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = string(data[field]);
      return value ? [[field, value]] : [];
    })
  );
}

function livePlayer(value: unknown): LivePlayer | undefined {
  const candidate = record(value);
  if (!candidate || typeof candidate.eosID !== 'string' || typeof candidate.name !== 'string') {
    return undefined;
  }
  return candidate as unknown as LivePlayer;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function date(value: unknown): Date {
  return value instanceof Date && !Number.isNaN(value.valueOf()) ? value : new Date();
}
