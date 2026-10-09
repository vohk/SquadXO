import type { LivePlayer } from '../domain/server-state.js';
import type { RconSquad } from '../rcon/squad-protocol.js';
import type { ReducedEvent } from '../server/state-reducer.js';

export interface LegacyEvent {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export function adaptLegacyEvent(
  event: ReducedEvent,
  squads: readonly RconSquad[] = []
): LegacyEvent {
  const data = { ...event.data };
  for (const key of ['player', 'attacker', 'victim', 'reviver'] as const) {
    const player = data[key];
    if (isLivePlayer(player)) data[key] = adaptLegacyPlayer(player, squads);
  }
  return { name: event.name, data };
}

export function adaptLegacyPlayer(
  player: LivePlayer,
  squads: readonly RconSquad[] = []
): Readonly<Record<string, unknown>> {
  const squad = squads.find(
    (candidate) => candidate.teamID === player.teamID && candidate.squadID === player.squadID
  );
  return {
    ...player,
    teamID: player.teamID ?? null,
    squadID: player.squadID ?? null,
    squad: squad ? { ...squad } : null,
    ...(player.controller ? { playercontroller: player.controller } : {})
  };
}

function isLivePlayer(value: unknown): value is LivePlayer {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).eosID === 'string' &&
    typeof (value as Record<string, unknown>).name === 'string'
  );
}
