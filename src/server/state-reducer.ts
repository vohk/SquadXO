import { EventEmitter } from 'node:events';
import { asEOSID, asSteamID, type EOSID } from '../domain/identity.js';
import { ServerState, type LivePlayer } from '../domain/server-state.js';
import type { ParsedLogEvent } from '../logs/parser.js';

export interface ReducedEvent {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class ServerStateReducer {
  constructor(readonly state: ServerState) {}

  reduce(parsed: ParsedLogEvent): ReducedEvent[] {
    const data = parsed.data;
    switch (parsed.name) {
      case 'PLAYER_CONNECTED': {
        const eosID = optionalEOSID(data.eosID);
        const name = firstString(data.suffix, data.playerSuffix, data.name, data.playercontroller);
        if (!eosID || !name) return [];
        const steamID = optionalSteamID(data.steamID);
        const controller = stringValue(data.playercontroller);
        const ip = stringValue(data.ip);
        this.state.upsertPlayer({
          eosID,
          ...(steamID ? { steamID } : {}),
          name,
          ...(controller ? { controller } : {}),
          ...(ip ? { ip } : {})
        });
        return [];
      }
      case 'JOIN_SUCCEEDED': {
        const eosID = optionalEOSID(data.eosID);
        const suffix = firstString(data.playerSuffix, data.suffix);
        if (!eosID) return [];
        const existing = this.state.getPlayerByEOSID(eosID);
        if (!existing) return [];
        const player = this.state.upsertPlayer({ ...existing, ...(suffix ? { suffix } : {}) });
        return [
          {
            name: 'PLAYER_CONNECTED',
            data: {
              time: data.time,
              ...(existing.ip ? { ip: existing.ip } : {}),
              player
            }
          }
        ];
      }
      case 'PLAYER_DISCONNECTED': {
        const eosID = optionalEOSID(data.eosID);
        if (!eosID) return [];
        const player = this.state.disconnectPlayer(eosID);
        return [{ name: parsed.name, data: { ...data, eosID, ...(player ? { player } : {}) } }];
      }
      case 'PLAYER_POSSESS': {
        const eosID = optionalEOSID(data.playerEOSID);
        const player = eosID ? this.state.getPlayerByEOSID(eosID) : undefined;
        const role = stringValue(data.possessClassname);
        const updated =
          player && role
            ? this.state.upsertPlayer({ ...player, role, possessClassname: role })
            : player;
        const { playerSuffix: _playerSuffix, ...legacyData } = data;
        return [
          {
            name: parsed.name,
            data: { ...legacyData, ...(updated ? { player: updated } : {}) }
          }
        ];
      }
      case 'PLAYER_UNPOSSESS': {
        const eosID = optionalEOSID(data.playerEOSID);
        const player = eosID ? this.state.getPlayerByEOSID(eosID) : undefined;
        const { playerSuffix: _playerSuffix, ...legacyData } = data;
        return [{ name: parsed.name, data: { ...legacyData, ...(player ? { player } : {}) } }];
      }
      case 'DEPLOYABLE_DAMAGED': {
        const suffix = firstString(data.playerSuffix, data.suffix);
        const player = suffix ? this.state.getPlayerByNameSuffix(suffix) : undefined;
        const { playerSuffix: _playerSuffix, ...legacyData } = data;
        return [{ name: parsed.name, data: { ...legacyData, ...(player ? { player } : {}) } }];
      }
      case 'PLAYER_DAMAGED':
      case 'PLAYER_WOUNDED':
      case 'PLAYER_DIED':
        return [{ name: parsed.name, data: this.#resolveParticipants(data, true) }];
      case 'PLAYER_REVIVED':
        return [{ name: parsed.name, data: this.#resolveParticipants(data) }];
      default:
        return [{ name: parsed.name, data }];
    }
  }

  #resolveParticipants(
    data: Readonly<Record<string, unknown>>,
    deriveTeamkill = false
  ): Readonly<Record<string, unknown>> {
    const attacker =
      this.#findParticipant(data.attackerEOSID, data.attackerName) ??
      this.#findParticipantByController(
        firstString(data.attackerPlayerController, data.attackerController)
      );
    const victim = this.#findParticipant(data.victimEOSID, data.victimName);
    const reviver = this.#findParticipant(data.reviverEOSID, data.reviverName);
    const teamkill =
      deriveTeamkill && attacker?.teamID !== undefined && victim?.teamID !== undefined
        ? attacker.teamID === victim.teamID && attacker.eosID !== victim.eosID
        : undefined;
    return {
      ...data,
      ...(attacker ? { attacker } : {}),
      ...(victim ? { victim } : {}),
      ...(reviver ? { reviver } : {}),
      ...(teamkill === undefined ? {} : { teamkill })
    };
  }

  #findParticipant(eosValue: unknown, nameValue: unknown): LivePlayer | undefined {
    const eosID = optionalEOSID(eosValue);
    if (eosID) return this.state.getPlayerByEOSID(eosID);
    const name = stringValue(nameValue);
    return name ? this.state.getPlayerByName(name) : undefined;
  }

  #findParticipantByController(controller: string | undefined): LivePlayer | undefined {
    return controller ? this.state.getPlayerByController(controller) : undefined;
  }
}

export class OrderedStateDispatcher extends EventEmitter {
  constructor(readonly reducer: ServerStateReducer) {
    super();
  }

  process(parsed: ParsedLogEvent): ReducedEvent[] {
    const events = this.reducer.reduce(parsed);
    for (const reduced of events) this.emit(reduced.name, reduced.data);
    return events;
  }
}

function optionalEOSID(value: unknown): EOSID | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return asEOSID(value);
  } catch {
    return undefined;
  }
}

function optionalSteamID(value: unknown): ReturnType<typeof asSteamID> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return asSteamID(value);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return undefined;
}
