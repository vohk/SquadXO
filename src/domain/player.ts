import type { PlayerIdentity } from './identity.js';

export interface Player extends PlayerIdentity {
  readonly name: string;
  readonly teamID?: number;
  readonly squadID?: number;
  readonly partyID?: number | null;
  readonly vehicle?: string | null;
  readonly role?: string;
}
