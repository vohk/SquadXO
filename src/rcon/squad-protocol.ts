import { asEOSID, asSteamID, type EOSID, type SteamID } from '../domain/identity.js';
import type { ServerInformationEvent } from '../domain/events.js';

export interface RconPlayer {
  readonly playerID: number;
  readonly eosID: EOSID;
  readonly steamID?: SteamID;
  readonly name: string;
  readonly teamID: number | null;
  readonly squadID: number | null;
  readonly partyID?: number | null;
  readonly vehicle?: string | null;
  readonly isLeader: boolean;
  readonly role: string;
}

export interface RconSquad {
  readonly squadID: number;
  readonly squadName: string;
  readonly size: number;
  readonly locked: boolean;
  readonly creatorName: string;
  readonly creatorEOSID: EOSID;
  readonly creatorSteamID?: SteamID;
  readonly teamID: number;
  readonly teamName: string;
  readonly teamTickets?: number;
}

export interface RconParty {
  readonly teamID: number;
  readonly partyID: number | null;
  readonly players: readonly RconPlayer[];
}

export interface LayerInformation {
  readonly level: string | null;
  readonly layer: string | null;
  readonly team1Faction: string | null;
  readonly team2Faction: string | null;
}

export interface RconChatMessage {
  readonly raw: string;
  readonly chat: string;
  readonly name: string;
  readonly message: string;
  readonly eosID: EOSID;
  readonly steamID?: SteamID;
  readonly time: Date;
}

export interface RconBroadcastEvent {
  readonly name:
    | 'CHAT_MESSAGE'
    | 'POSSESSED_ADMIN_CAMERA'
    | 'UNPOSSESSED_ADMIN_CAMERA'
    | 'PLAYER_WARNED'
    | 'PLAYER_KICKED'
    | 'PLAYER_BANNED'
    | 'SQUAD_CREATED';
  readonly data: Readonly<Record<string, unknown>>;
}

interface ParsedOnlineIDs {
  readonly eosID: EOSID;
  readonly steamID?: SteamID;
}

export function parseOnlineIDs(value: string): ParsedOnlineIDs | undefined {
  const eosMatch = value.match(/(?:EOS|eos):\s*([0-9a-f]{32})/i);
  if (!eosMatch?.[1]) return undefined;
  const steamMatch = value.match(/steam:\s*(\d{17})/i);
  const eosID = asEOSID(eosMatch[1]);
  return steamMatch?.[1] ? { eosID, steamID: asSteamID(steamMatch[1]) } : { eosID };
}

export function parseChatMessage(
  body: string,
  time: Date = new Date()
): RconChatMessage | undefined {
  const groups = body.match(
    /^\[(?<chat>ChatAll|ChatTeam|ChatSquad|ChatAdmin)] \[Online IDs:(?<onlineIDs>[^\]]+)] (?<name>.+?) : (?<message>.*)$/s
  )?.groups;
  if (!groups) return undefined;
  const identity = parseOnlineIDs(groups.onlineIDs ?? '');
  if (!identity) return undefined;
  return {
    raw: body,
    chat: groups.chat ?? '',
    name: groups.name ?? '',
    message: groups.message ?? '',
    ...identity,
    time
  };
}

export function parseRconBroadcast(
  body: string,
  time: Date = new Date()
): RconBroadcastEvent | undefined {
  const chat = parseChatMessage(body, time);
  if (chat) return { name: 'CHAT_MESSAGE', data: { ...chat } };

  const possessed = body.match(/^\[Online IDs?:([^\]]+)] (.+) has possessed admin camera\.$/i);
  if (possessed?.[1] && possessed[2]) {
    const identity = parseOnlineIDs(possessed[1]);
    if (!identity) return undefined;
    return {
      name: 'POSSESSED_ADMIN_CAMERA',
      data: { raw: body, name: possessed[2], ...identity, time }
    };
  }

  const unpossessed = body.match(/^\[Online IDs?:([^\]]+)] (.+) has unpossessed admin camera\.$/i);
  if (unpossessed?.[1] && unpossessed[2]) {
    const identity = parseOnlineIDs(unpossessed[1]);
    if (!identity) return undefined;
    return {
      name: 'UNPOSSESSED_ADMIN_CAMERA',
      data: { raw: body, name: unpossessed[2], ...identity, time }
    };
  }

  const warned = body.match(/^Remote admin has warned player (.*)\. Message was "(.*)"$/s);
  if (warned?.[1] !== undefined && warned[2] !== undefined) {
    return {
      name: 'PLAYER_WARNED',
      data: { raw: body, name: warned[1], reason: warned[2], time }
    };
  }

  const kicked = body.match(/^Kicked player (\d+)\. \[Online IDs=([^\]]+)] (.*)$/s);
  if (kicked?.[1] && kicked[2] && kicked[3] !== undefined) {
    const identity = parseOnlineIDs(kicked[2]);
    if (!identity) return undefined;
    return {
      name: 'PLAYER_KICKED',
      data: { raw: body, playerID: Number(kicked[1]), name: kicked[3], ...identity, time }
    };
  }

  const banned = body.match(
    /^Banned player (\d+)\. \[Online IDs=([^\]]+)] (.*) for interval (.*)$/s
  );
  if (banned?.[1] && banned[2] && banned[3] !== undefined && banned[4] !== undefined) {
    const identity = parseOnlineIDs(banned[2]);
    if (!identity) return undefined;
    return {
      name: 'PLAYER_BANNED',
      data: {
        raw: body,
        playerID: Number(banned[1]),
        name: banned[3],
        interval: banned[4],
        ...identity,
        time
      }
    };
  }

  const squad = body.match(
    /^(.*) \(Online IDs:([^)]+)\) has created Squad (\d+) \(Squad Name: (.+)\) on (.+)$/s
  );
  if (squad?.[1] && squad[2] && squad[3] && squad[4] && squad[5]) {
    const identity = parseOnlineIDs(squad[2]);
    if (!identity) return undefined;
    return {
      name: 'SQUAD_CREATED',
      data: {
        raw: body,
        playerName: squad[1],
        squadID: Number(squad[3]),
        squadName: squad[4],
        teamName: squad[5],
        ...identity,
        time
      }
    };
  }

  return undefined;
}

export function parsePlayerList(response: string): RconPlayer[] {
  const players: RconPlayer[] = [];
  const pattern =
    /^ID: (?<playerID>\d+) \| Online IDs:(?<onlineIDs>[^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamID>\d+|N\/A)(?: \| Party ID: (?<partyID>#\d+|N\/A))? \| Squad ID: (?<squadID>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>[^|]+?)(?: \| Vehicle: (?<vehicle>[^|]+))?$/;

  let recognized = response.includes('----- Active Players -----');
  const ids = new Set<string>();
  for (const line of response.split(/\r?\n/)) {
    if (line.startsWith('----- Recently Disconnected Players')) break;
    if (!line.trim() || line === '----- Active Players -----') continue;
    if (!line.startsWith('ID:')) throw new Error('Unexpected ListPlayers active-player row');
    recognized = true;
    const groups = line.match(pattern)?.groups;
    if (!groups) throw new Error('Unexpected ListPlayers active-player row');
    const identity = parseOnlineIDs(groups.onlineIDs ?? '');
    if (!identity || ids.has(identity.eosID)) {
      throw new Error('ListPlayers active-player identity is missing or duplicated');
    }
    ids.add(identity.eosID);
    players.push({
      playerID: Number(groups.playerID),
      ...identity,
      name: groups.name ?? '',
      teamID: groups.teamID === 'N/A' ? null : Number(groups.teamID),
      squadID: groups.squadID === 'N/A' ? null : Number(groups.squadID),
      isLeader: groups.isLeader === 'True',
      role: groups.role ?? '',
      ...(groups.partyID === undefined
        ? {}
        : { partyID: groups.partyID === 'N/A' ? null : Number(groups.partyID.slice(1)) }),
      ...(groups.vehicle === undefined
        ? {}
        : { vehicle: groups.vehicle === 'N/A' ? null : groups.vehicle })
    });
  }
  if (!recognized) throw new Error('Unexpected ListPlayers response');
  return players;
}

export function parseSquadList(response: string): RconSquad[] {
  const squads: RconSquad[] = [];
  const squadPattern =
    /^ID: (?<squadID>\d+) \| Name: (?<squadName>.+) \| Size: (?<size>\d+) \| Locked: (?<locked>True|False) \| Creator Name: (?<creatorName>.+) \| Creator Online IDs:(?<onlineIDs>[^|]+)(?:\|.*)?$/;
  let teamID: number | undefined;
  let teamName: string | undefined;
  let teamTickets: number | undefined;

  for (const line of response.split(/\r?\n/)) {
    if (line.startsWith('Team ID:')) {
      teamID = undefined;
      teamName = undefined;
      teamTickets = undefined;
    }
    const teamMatch = line.match(
      /^Team ID: (?<teamID>\d+) \((?<teamName>.+)\)(?: - Tickets: (?<tickets>\d+))?$/
    )?.groups;
    if (teamMatch) {
      teamID = Number(teamMatch.teamID);
      teamName = teamMatch.teamName;
      teamTickets = teamMatch.tickets === undefined ? undefined : Number(teamMatch.tickets);
      continue;
    }

    const groups = line.match(squadPattern)?.groups;
    if (!groups || teamID === undefined || teamName === undefined) continue;
    const identity = parseOnlineIDs(groups.onlineIDs ?? '');
    if (!identity) continue;
    squads.push({
      squadID: Number(groups.squadID),
      squadName: groups.squadName ?? '',
      size: Number(groups.size),
      locked: groups.locked === 'True',
      creatorName: groups.creatorName ?? '',
      creatorEOSID: identity.eosID,
      ...(identity.steamID ? { creatorSteamID: identity.steamID } : {}),
      teamID,
      teamName,
      ...(teamTickets === undefined ? {} : { teamTickets })
    });
  }
  return squads;
}

export function parsePartyList(response: string): RconParty[] {
  const parties: RconParty[] = [];
  let teamID: number | undefined;
  let party: { teamID: number; partyID: number | null; players: RconPlayer[] } | undefined;

  for (const line of response.split(/\r?\n/)) {
    if (line.startsWith('Team ')) {
      teamID = undefined;
      party = undefined;
      const team = line.match(/^Team (\d+)$/);
      if (team?.[1]) teamID = Number(team[1]);
      continue;
    }
    if (line === 'No Party' || line.startsWith('Party #')) {
      party = undefined;
      const group = line.match(/^Party #(\d+)$/);
      if (teamID === undefined || (line !== 'No Party' && !group)) continue;
      party = { teamID, partyID: group?.[1] === undefined ? null : Number(group[1]), players: [] };
      parties.push(party);
      continue;
    }
    if (!party) continue;
    const member = line.match(
      /^(?<name>.+) \| ID: (?<playerID>\d+) \| Online IDs:(?<onlineIDs>[^|]+)\| Squad ID: (?<squadID>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>[^|]+)$/
    )?.groups;
    if (!member) continue;
    const identity = parseOnlineIDs(member.onlineIDs ?? '');
    if (!identity) continue;
    party.players.push({
      playerID: Number(member.playerID),
      ...identity,
      name: member.name ?? '',
      teamID: party.teamID,
      partyID: party.partyID,
      squadID: member.squadID === 'N/A' ? null : Number(member.squadID),
      isLeader: member.isLeader === 'True',
      role: member.role ?? ''
    });
  }
  return parties;
}

export function parseCurrentLayer(response: string): LayerInformation {
  const match = response.match(/^Current level is (.*), layer is (.*), factions (\S+) (\S+)\s*$/);
  if (!match) throw new Error(`Unexpected ShowCurrentMap response: ${response}`);
  return {
    level: match[1] || null,
    layer: match[2] || null,
    team1Faction: match[3] || null,
    team2Faction: match[4] || null
  };
}

export function parseNextLayer(response: string): LayerInformation {
  const match = response.match(/^Next level is (.*), layer is (.*), factions (\S*)\s*(\S*)\s*$/);
  if (!match) throw new Error(`Unexpected ShowNextMap response: ${response}`);
  return {
    level: match[1] || null,
    layer: !match[2] || match[2] === 'To be voted' ? null : match[2],
    team1Faction: match[3] || null,
    team2Faction: match[4] || null
  };
}

export function parseServerInfo(response: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(response);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ShowServerInfo response must be a JSON object');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function normalizeServerInformation(
  raw: Readonly<Record<string, unknown>>,
  now: Date = new Date()
): ServerInformationEvent {
  const serverName = text(raw.ServerName_s);
  const maxPlayers = numeric(raw.MaxPlayers) ?? 0;
  const reserveSlots = numeric(raw.PlayerReserveCount_I) ?? 0;
  const playerCount = numeric(raw.PlayerCount_I) ?? 0;
  const publicQueue = numeric(raw.PublicQueue_I) ?? 0;
  const reserveQueue = numeric(raw.ReservedQueue_I) ?? 0;
  const playtime = numeric(raw.PLAYTIME_I);
  const currentLayer = text(raw.MapName_s);
  const nextLayer = text(raw.NextLayer_s);
  return {
    raw: { ...raw },
    ...(serverName ? { serverName } : {}),
    maxPlayers,
    publicQueueLimit: numeric(raw.PublicQueueLimit_I) ?? 0,
    reserveSlots,
    publicSlots: Math.max(0, maxPlayers - reserveSlots),
    playerCount,
    a2sPlayerCount: playerCount,
    publicQueue,
    reserveQueue,
    ...(currentLayer ? { currentLayer } : {}),
    ...(nextLayer ? { nextLayer } : {}),
    teamOne: withoutMapName(text(raw.TeamOne_s), currentLayer),
    teamTwo: withoutMapName(text(raw.TeamTwo_s), currentLayer),
    matchTimeout: numeric(raw.MatchTimeout_d) ?? 0,
    ...(playtime === undefined
      ? {}
      : { playtime, matchStartTime: new Date(now.getTime() - playtime * 1000) }),
    ...(text(raw.GameVersion_s) ? { gameVersion: text(raw.GameVersion_s) } : {})
  };
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function withoutMapName(value: string | undefined, mapName: string | undefined): string {
  if (!value) return '';
  if (!mapName) return value;
  return value.replace(new RegExp(escapeRegExp(mapName), 'i'), '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
