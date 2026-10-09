export interface ParsedLogEvent {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ParserWarning {
  readonly line: number;
  readonly category: string;
}

export interface ParserStatistics {
  readonly totalLines: number;
  readonly matchedLines: number;
  readonly unknownLines: number;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly warningCount: number;
  readonly warnings: readonly ParserWarning[];
  readonly correlationSize: number;
  readonly peakCorrelationSize: number;
}

interface RuleMatch {
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

interface ParserRule {
  readonly regex: RegExp;
  readonly match: (match: RegExpMatchArray, raw: string) => RuleMatch | undefined;
}

interface CorrelationEntry extends Record<string, unknown> {
  updatedAt: number;
}

interface ParserOptions {
  readonly correlationTtlMs?: number;
  readonly maximumCorrelations?: number;
  readonly maximumWarnings?: number;
  readonly now?: () => number;
}

const IMPORTANT_UNKNOWN = [
  [
    'connection',
    /(?:LogNet: (?:Join request:|Login request:)|LogSquad: (?:PostLogin: NewPlayer:|Login: NewPlayer:)|SQCommonStatics Check Permissions)/
  ],
  ['combat', /(?:ActualDamage=|Wound\(\)|Die\(\)|has revived)/],
  ['round', /(?:Match State Changed from InProgress|has (?:won|lost) the match)/],
  ['tick-rate', /Server Tick Rate:/],
  ['capture-zone', /LogSquad: Capture zone /],
  ['map-marker', /placed a new map marker/],
  ['deployable-spawn', /LogSquad: Deployable .* spawned for team /]
] as const;

export class SquadLogParser {
  readonly #correlationTtlMs: number;
  readonly #maximumCorrelations: number;
  readonly #maximumWarnings: number;
  readonly #now: () => number;
  readonly #joins = new Map<number, CorrelationEntry>();
  readonly #combat = new Map<string, CorrelationEntry>();
  readonly #possessions = new Map<string, CorrelationEntry>();
  #lastConnection: CorrelationEntry | undefined;
  #winner: Record<string, unknown> | undefined;
  #loser: Record<string, unknown> | undefined;
  #worldWinner: Record<string, unknown> | undefined;
  #totalLines = 0;
  #matchedLines = 0;
  #warningCount = 0;
  #peakCorrelationSize = 0;
  readonly #eventCounts: Record<string, number> = {};
  readonly #warnings: ParserWarning[] = [];

  constructor(options: ParserOptions = {}) {
    this.#correlationTtlMs = options.correlationTtlMs ?? 10 * 60_000;
    this.#maximumCorrelations = options.maximumCorrelations ?? 4096;
    this.#maximumWarnings = options.maximumWarnings ?? 20;
    this.#now = options.now ?? Date.now;
  }

  parseLine(raw: string): ParsedLogEvent[] {
    this.#totalLines += 1;

    for (const parserRule of RULES) {
      const match = raw.match(parserRule.regex);
      if (!match) continue;
      const result = parserRule.match(match, raw);
      if (!result) return [];
      this.#matchedLines += 1;
      if (this.#totalLines % 1000 === 0) {
        const referenceTime = result.data.time;
        this.#expireCorrelations(
          referenceTime instanceof Date ? referenceTime.getTime() : this.#now()
        );
      }
      const events = this.#apply(result);
      for (const event of events) {
        this.#eventCounts[event.name] = (this.#eventCounts[event.name] ?? 0) + 1;
      }
      this.#updatePeak();
      return events;
    }

    this.#recordImportantUnknown(raw);
    return [];
  }

  statistics(): ParserStatistics {
    return {
      totalLines: this.#totalLines,
      matchedLines: this.#matchedLines,
      unknownLines: this.#totalLines - this.#matchedLines,
      eventCounts: { ...this.#eventCounts },
      warningCount: this.#warningCount,
      warnings: [...this.#warnings],
      correlationSize: this.#correlationSize(),
      peakCorrelationSize: this.#peakCorrelationSize
    };
  }

  #apply(result: RuleMatch): ParsedLogEvent[] {
    const data = result.data;
    const time = data.time instanceof Date ? data.time.getTime() : this.#now();
    switch (result.kind) {
      case 'CLIENT_JOIN_REQUEST': {
        const chainID = numberValue(data.chainID);
        if (chainID !== undefined) this.#setBounded(this.#joins, chainID, data, time);
        return [event(result.kind, data)];
      }
      case 'CLIENT_LOGIN_REQUEST': {
        const chainID = numberValue(data.chainID);
        if (chainID !== undefined) this.#mergeJoin(chainID, data, time);
        return [event(result.kind, data)];
      }
      case 'PLAYER_CONNECTED': {
        const chainID = numberValue(data.chainID);
        const merged =
          chainID === undefined ? data : withoutUpdatedAt(this.#mergeJoin(chainID, data, time));
        return [event(result.kind, merged)];
      }
      case 'PLAYER_CONTROLLER_CONNECTED':
      case 'CLIENT_LOGIN':
      case 'RESOLVED_EOS_ID': {
        const chainID = numberValue(data.chainID);
        if (chainID === undefined) return [event(result.kind, data)];
        const correlation = this.#joins.get(chainID);
        if (!correlation) {
          if (result.kind === 'RESOLVED_EOS_ID') return [];
          this.#warn(`${result.kind.toLowerCase()}-without-join`);
          return [event(result.kind, data)];
        }
        if (result.kind === 'RESOLVED_EOS_ID' && correlation.eosID === data.eosID) return [];
        const merged = this.#mergeJoin(chainID, data, time);
        return [event(result.kind, withoutUpdatedAt(merged))];
      }
      case 'JOIN_SUCCEEDED': {
        const chainID = numberValue(data.chainID);
        const correlation = chainID === undefined ? undefined : this.#joins.get(chainID);
        if (!correlation) this.#warn('join-succeeded-without-correlation');
        if (chainID !== undefined) this.#joins.delete(chainID);
        return [event(result.kind, { ...withoutUpdatedAt(correlation), ...data })];
      }
      case 'ADDING_CLIENT_CONNECTION':
        this.#lastConnection = { ...data, updatedAt: time };
        return [event(result.kind, data)];
      case 'AUTH_RESULT': {
        if (!this.#lastConnection) return [];
        const merged = { ...withoutUpdatedAt(this.#lastConnection), ...data };
        this.#lastConnection = undefined;
        return [event('CLIENT_CONNECTED', merged)];
      }
      case 'PLAYER_DISCONNECTED': {
        return [event(result.kind, data)];
      }
      case 'PLAYER_DAMAGED':
      case 'PLAYER_WOUNDED':
      case 'PLAYER_DIED': {
        const victimName = stringValue(data.victimName);
        const previous = victimName ? this.#combat.get(victimName) : undefined;
        const merged = { ...withoutUpdatedAt(previous), ...data };
        if (victimName) this.#setBounded(this.#combat, victimName, merged, time);
        return [event(result.kind, merged)];
      }
      case 'PLAYER_REVIVED': {
        const victimName = stringValue(data.victimName);
        const previous = victimName ? this.#combat.get(victimName) : undefined;
        if (victimName) this.#combat.delete(victimName);
        return [event(result.kind, { ...withoutUpdatedAt(previous), ...data })];
      }
      case 'PLAYER_POSSESS': {
        const suffix = stringValue(data.playerSuffix);
        if (suffix) this.#setBounded(this.#possessions, suffix, data, time);
        return [event(result.kind, data)];
      }
      case 'PLAYER_UNPOSSESS': {
        const suffix = stringValue(data.playerSuffix);
        const switchPossess = suffix ? this.#possessions.has(suffix) : false;
        if (suffix) this.#possessions.delete(suffix);
        return [event(result.kind, { ...data, switchPossess })];
      }
      case 'ROUND_RESULT':
        if (data.action === 'won') this.#winner = data;
        else this.#loser = data;
        return [];
      case 'ROUND_WINNER':
        this.#worldWinner = this.#worldWinner ? { ...data, winner: null } : data;
        return [];
      case 'ROUND_ENDED': {
        const round = event('ROUND_ENDED', {
          ...data,
          winner: this.#winner ?? null,
          loser: this.#loser ?? null
        });
        this.#winner = undefined;
        this.#loser = undefined;
        return [round];
      }
      case 'NEW_GAME': {
        const newGame = event(result.kind, { ...this.#worldWinner, ...data });
        this.#worldWinner = undefined;
        this.#combat.clear();
        this.#possessions.clear();
        return [newGame];
      }
      case 'IGNORE':
        return [];
      default:
        return [event(result.kind, data)];
    }
  }

  #mergeJoin(chainID: number, data: Record<string, unknown>, time: number): CorrelationEntry {
    const merged = { ...withoutUpdatedAt(this.#joins.get(chainID)), ...data, updatedAt: time };
    this.#setBounded(this.#joins, chainID, merged, time);
    return merged;
  }

  #setBounded<Key>(
    map: Map<Key, CorrelationEntry>,
    key: Key,
    data: Record<string, unknown>,
    time: number
  ): void {
    if (!map.has(key) && this.#correlationSize() >= this.#maximumCorrelations) {
      this.#evictOldestCorrelation();
      this.#warn('correlation-capacity-eviction');
    }
    map.set(key, { ...data, updatedAt: time });
  }

  #expireCorrelations(referenceTime: number): void {
    const cutoff = referenceTime - this.#correlationTtlMs;
    const maps: Map<unknown, CorrelationEntry>[] = [this.#joins, this.#combat, this.#possessions];
    for (const map of maps) {
      for (const [key, value] of map) if (value.updatedAt < cutoff) map.delete(key);
    }
    if (this.#lastConnection && this.#lastConnection.updatedAt < cutoff) {
      this.#lastConnection = undefined;
    }
  }

  #evictOldestCorrelation(): void {
    let oldest:
      { map: Map<unknown, CorrelationEntry>; key: unknown; updatedAt: number } | undefined;
    const maps: Map<unknown, CorrelationEntry>[] = [this.#joins, this.#combat, this.#possessions];
    for (const map of maps) {
      for (const [key, value] of map) {
        if (!oldest || value.updatedAt < oldest.updatedAt) {
          oldest = { map, key, updatedAt: value.updatedAt };
        }
      }
    }
    if (this.#lastConnection && (!oldest || this.#lastConnection.updatedAt < oldest.updatedAt)) {
      this.#lastConnection = undefined;
    } else if (oldest) {
      oldest.map.delete(oldest.key);
    }
  }

  #recordImportantUnknown(raw: string): void {
    for (const [category, pattern] of IMPORTANT_UNKNOWN) {
      if (!pattern.test(raw)) continue;
      this.#warn(`unmatched-${category}`);
      return;
    }
  }

  #warn(category: string): void {
    this.#warningCount += 1;
    if (this.#warnings.length < this.#maximumWarnings) {
      this.#warnings.push({ line: this.#totalLines, category });
    }
  }

  #correlationSize(): number {
    return (
      this.#joins.size + this.#combat.size + this.#possessions.size + (this.#lastConnection ? 1 : 0)
    );
  }

  #updatePeak(): void {
    this.#peakCorrelationSize = Math.max(this.#peakCorrelationSize, this.#correlationSize());
  }
}

function rule(
  kind: string,
  regex: RegExp,
  map: (match: RegExpMatchArray, raw: string) => Record<string, unknown> | undefined
): ParserRule {
  return {
    regex,
    match: (matched, raw) => {
      const data = map(matched, raw);
      return data ? { kind, data } : undefined;
    }
  };
}

function source(match: RegExpMatchArray, raw: string): Record<string, unknown> {
  return {
    raw,
    time: parseSquadTimestamp(match[1] ?? ''),
    chainID: Number((match[2] ?? '').trim())
  };
}

function prefixedIDs(value: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/\b(EOS|steam):\s*([0-9a-f]{32}|\d{17})/gi)) {
    const isEOS = match[1]?.toLowerCase() === 'eos';
    const platform = prefix ? (isEOS ? 'EOSID' : 'SteamID') : isEOS ? 'eosID' : 'steamID';
    if (match[2]) result[`${prefix}${platform}`] = match[2].toLowerCase();
  }
  return result;
}

export function parseSquadTimestamp(value: string): Date {
  const match = value.match(/^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})$/);
  if (!match) return new Date(Number.NaN);
  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7])
    )
  );
}

const RULES: readonly ParserRule[] = [
  rule(
    'ADDING_CLIENT_CONNECTION',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: AddClientConnection: Added client connection: \[UNetConnection] RemoteAddr: ([\d.]+):[0-9]+, Name: (EOSIpNetConnection_[0-9]+), Driver: GameNetDriver (EOSNetDriver_[0-9]+), IsServer: YES, PC: NULL, Owner: NULL, UniqueId: INVALID/,
    (m, raw) => ({ ...source(m, raw), ip: m[3], connection: m[4], driver: m[5] })
  ),
  rule(
    'ADMIN_BROADCAST',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Message broadcasted <(.+)> from (.+)/,
    (m, raw) => ({ ...source(m, raw), message: m[3], from: m[4] })
  ),
  rule(
    'RESOLVED_EOS_ID',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadCommon: SQCommonStatics Check Permissions(?: succeeded)?, UniqueId:([\da-f]+)$/,
    (m, raw) => ({ ...source(m, raw), eosID: m[3] })
  ),
  rule(
    'CLIENT_EXTERNAL_ACCOUNT_INFO',
    /^\[([0-9.:-]+)]\[([ 0-9]+)]LogEOS: Verbose: \[LogEOSConnect] FConnectClient::CacheExternalAccountInfo - ProductUserId: ([0-9a-f]{32}), AccountType: (\d), AccountId: ([0-9]{17}), DisplayName: <Redacted>/,
    (m, raw) => ({ ...source(m, raw), eosID: m[3], steamID: m[5] })
  ),
  rule(
    'CLIENT_LOGIN',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Login: NewPlayer: (?:Redpoint)?EOSIpNetConnection \/Engine\/Transient\.((?:Redpoint)?EOSIpNetConnection_[0-9]+)/,
    (m, raw) => ({ ...source(m, raw), connection: m[3] })
  ),
  rule(
    'CLIENT_JOIN_REQUEST',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: Join request: .+\?Name=(.+)\?SplitscreenCount=\d(?:#.*)?$/,
    (m, raw) => ({ ...source(m, raw), suffix: m[3] })
  ),
  rule(
    'CLIENT_LOGIN_REQUEST',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: Login request: \?Name=(.+?)(?:\?PASSWORD=(?:.+?))? userId: RedpointEOS:([\da-f]{32}) platform: RedpointEOS/,
    (m, raw) => ({ ...source(m, raw), suffix: m[3], eosID: m[4] })
  ),
  rule(
    'PLAYER_CONNECTED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: PostLogin: NewPlayer: BP_PlayerController(?:|.+)_C .+PersistentLevel\.([^\s]+) \(IP: ([\d.]+) \| Online IDs:([^)|]+)\)/,
    (m, raw) => ({
      ...source(m, raw),
      playercontroller: m[3],
      ip: m[4],
      ...prefixedIDs(m[5] ?? '')
    })
  ),
  rule(
    'PLAYER_CONTROLLER_CONNECTED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: PostLogin: NewPlayer: BP_PlayerController_.* .+(BP_PlayerController_.*_[0-9]+)/,
    (m, raw) => ({ ...source(m, raw), controller: m[3] })
  ),
  rule('JOIN_SUCCEEDED', /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: Join succeeded: (.+)/, (m, raw) => ({
    ...source(m, raw),
    playerSuffix: m[3]
  })),
  rule(
    'PLAYER_DISCONNECTED',
    /^\[([\d.:-]+)]\[([ \d]*)]LogNet: UChannel::Close: Sending CloseBunch\..+RemoteAddr: ([\d.]+).+PC: (\w+PlayerController(?:|.+)_C_\d+),.+UniqueId: RedpointEOS:([\d\w]+)/,
    (m, raw) => ({ ...source(m, raw), ip: m[3], playerController: m[4], eosID: m[5] })
  ),
  rule(
    'AUTH_RESULT',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogOnline: STEAM: AUTH HANDLER: Sending auth result to user (\d{17}) with flag success\? 1/,
    (m, raw) => ({ ...source(m, raw), steamID: m[3] })
  ),
  rule(
    'CAPTURE_ZONE_CAPTURED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Capture zone (.+) was fully captured by team (\d+)$/,
    (m, raw) => ({ ...source(m, raw), zoneName: m[3], teamID: Number(m[4]) })
  ),
  rule(
    'CAPTURE_ZONE_NEUTRALIZED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Capture zone (.+) was neutralized by team (\d+) \(was owned by team (\d+)\)$/,
    (m, raw) => ({
      ...source(m, raw),
      zoneName: m[3],
      teamID: Number(m[4]),
      previousTeamID: Number(m[5])
    })
  ),
  rule(
    'MAP_MARKER_PLACED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Player (.+) \(Team: (\d+); ID: ([^)]+)\) placed a new map marker for team (\d+) : Type: ([A-Za-z0-9_]+) ; Location: (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)$/,
    (m, raw) => ({
      ...source(m, raw),
      playerName: m[3],
      playerTeamID: Number(m[4]),
      ...prefixedIDs(m[5] ?? ''),
      teamID: Number(m[6]),
      markerType: m[7],
      location: { x: Number(m[8]), y: Number(m[9]), z: Number(m[10]) }
    })
  ),
  rule(
    'DEPLOYABLE_SPAWNED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Deployable ([A-Za-z0-9_]+) spawned for team (\d+) at location \{(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\}$/,
    (m, raw) => ({
      ...source(m, raw),
      deployable: m[3],
      teamID: Number(m[4]),
      location: { x: Number(m[5]), y: Number(m[6]), z: Number(m[7]) }
    })
  ),
  rule(
    'DEPLOYABLE_DAMAGED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQDeployable::)?TakeDamage\(\): ([A-Za-z0-9_]+)_C_[0-9]+: ([0-9.]+) damage attempt by causer ([A-Za-z0-9_]+)_C_[0-9]+ instigator (.+) with damage type ([A-Za-z0-9_]+)_C health remaining ([0-9.]+)/,
    (m, raw) => ({
      ...source(m, raw),
      deployable: m[3],
      damage: Number(m[4]),
      weapon: m[5],
      playerSuffix: m[6],
      damageType: m[7],
      healthRemaining: Number(m[8])
    })
  ),
  rule(
    'PLAYER_DAMAGED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Player:(.+) ActualDamage=([0-9.]+) from (.+) \(Online IDs:([^|]+)\| Player Controller ID: ([^ ]+)\)caused by ([A-Za-z_0-9-]+)/,
    (m, raw) => ({
      ...source(m, raw),
      victimName: m[3],
      damage: Number(m[4]),
      attackerName: m[5],
      ...prefixedIDs(m[6] ?? '', 'attacker'),
      attackerController: m[7],
      weapon: m[8]
    })
  ),
  ...(['PLAYER_WOUNDED', 'PLAYER_DIED'] as const).map((kind) =>
    rule(
      kind,
      kind === 'PLAYER_WOUNDED'
        ? /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Wound\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from (.+?) \(Online IDs:([^)|]+)\| Controller ID: ([\w\d]+)\) caused by ([A-Za-z_0-9-]+)/
        : /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Die\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from (.+?) \(Online IDs:([^)|]+)\| Contoller ID: ([\w\d]+)\) caused by ([A-Za-z_0-9-]+)/,
      (m, raw) => ({
        ...source(m, raw),
        ...(kind === 'PLAYER_DIED' ? { woundTime: parseSquadTimestamp(m[1] ?? '') } : {}),
        victimName: m[3],
        damage: Number(m[4]),
        attackerPlayerController: m[5],
        ...prefixedIDs(m[6] ?? '', 'attacker'),
        attackerController: m[7],
        weapon: m[8]?.replace(/_C$/, '')
      })
    )
  ),
  rule(
    'PLAYER_REVIVED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: (.+) \(Online IDs:([^)]+)\) has revived (.+) \(Online IDs:([^)]+)\)\./,
    (m, raw) => ({
      ...source(m, raw),
      reviverName: m[3],
      ...prefixedIDs(m[4] ?? '', 'reviver'),
      victimName: m[5],
      ...prefixedIDs(m[6] ?? '', 'victim')
    })
  ),
  rule(
    'PLAYER_POSSESS',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQPlayerController::)?OnPossess\(\): PC=(.+) \(Online IDs:([^)]+)\) Pawn=([A-Za-z0-9_]+)_C/,
    (m, raw) => ({
      ...source(m, raw),
      playerSuffix: m[3],
      ...prefixedIDs(m[4] ?? '', 'player'),
      possessClassname: m[5]
    })
  ),
  rule(
    'PLAYER_UNPOSSESS',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQPlayerController::)?OnUnPossess\(\): PC=(.+) \(Online IDs:([^)]+)\)/,
    (m, raw) => ({
      ...source(m, raw),
      playerSuffix: m[3],
      ...prefixedIDs(m[4] ?? '', 'player')
    })
  ),
  rule(
    'ROUND_RESULT',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadGameEvents: Display: Team ([0-9]), (.*) \( ?(.*?) ?\) has (won|lost) the match with ([0-9]+) Tickets on layer (.*) \(level (.*)\)!/,
    (m, raw) => ({
      ...source(m, raw),
      team: Number(m[3]),
      subfaction: m[4],
      faction: m[5],
      action: m[6],
      tickets: Number(m[7]),
      layer: m[8],
      level: m[9]
    })
  ),
  rule(
    'ROUND_WINNER',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQGameMode::)?DetermineMatchWinner\(\): (.+) won on (.+)/,
    (m, raw) => ({ ...source(m, raw), winner: m[3], layer: m[4] })
  ),
  rule(
    'IGNORE',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameMode: Display: Match State Changed from InProgress to WaitingPostMatch/,
    (m, raw) => source(m, raw)
  ),
  rule(
    'ROUND_ENDED',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameState: Match State Changed from InProgress to WaitingPostMatch/,
    (m, raw) => source(m, raw)
  ),
  rule(
    'IGNORE',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogWorld: Bringing World \/.*TransitionMap/,
    (m, raw) => source(m, raw)
  ),
  rule(
    'NEW_GAME',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogWorld: Bringing World \/([A-Za-z0-9_]+)\/(?:Maps\/)?([A-Za-z0-9_-]+)\/(?:.+\/)?([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)/,
    (m, raw) => ({
      ...source(m, raw),
      dlc: m[3],
      mapClassname: m[4],
      layerClassname: m[5]
    })
  ),
  rule(
    'TICK_RATE',
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: USQGameState: Server Tick Rate: ([0-9.]+)/,
    (m, raw) => ({ ...source(m, raw), tickRate: Number(m[3]) })
  )
];

function event(name: string, data: Record<string, unknown>): ParsedLogEvent {
  return { name, data };
}

function withoutUpdatedAt(
  value: CorrelationEntry | Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!value) return {};
  const { updatedAt: _updatedAt, ...rest } = value;
  return rest;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
