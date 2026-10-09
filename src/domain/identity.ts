declare const identityBrand: unique symbol;

type BrandedID<Name extends string> = string & { readonly [identityBrand]: Name };

export type EOSID = BrandedID<'EOSID'>;
export type SteamID = BrandedID<'SteamID'>;

export interface PlayerIdentity {
  readonly eosID: EOSID;
  readonly steamID?: SteamID;
}

export function asEOSID(value: string): EOSID {
  if (!/^[0-9a-f]{32}$/i.test(value)) {
    throw new TypeError('EOS ID must be exactly 32 hexadecimal characters');
  }
  return value.toLowerCase() as EOSID;
}

export function asSteamID(value: string): SteamID {
  if (!/^\d{17}$/.test(value)) {
    throw new TypeError('Steam ID must be exactly 17 decimal digits');
  }
  return value as SteamID;
}
