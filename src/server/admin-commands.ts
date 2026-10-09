import type { EOSID } from '../domain/identity.js';
import type { LivePlayer } from '../domain/server-state.js';

export interface AdminRcon {
  warn(eosID: EOSID, message: string): Promise<void>;
  kick(eosID: EOSID, reason: string): Promise<void>;
  forceTeamChange(eosID: EOSID): Promise<void>;
}

export class AdminCommands {
  constructor(readonly rcon: AdminRcon) {}

  warn(player: LivePlayer | EOSID, message: string): Promise<void> {
    return this.rcon.warn(eosIDOf(player), message);
  }

  kick(player: LivePlayer | EOSID, reason: string): Promise<void> {
    return this.rcon.kick(eosIDOf(player), reason);
  }

  forceTeamChange(player: LivePlayer | EOSID): Promise<void> {
    return this.rcon.forceTeamChange(eosIDOf(player));
  }
}

function eosIDOf(player: LivePlayer | EOSID): EOSID {
  return typeof player === 'string' ? player : player.eosID;
}
