import { DataTypes, Op, type Model, type ModelStatic, type Sequelize } from 'sequelize';
import type { EOSID } from '../domain/identity.js';
import type { LivePlayer } from '../domain/server-state.js';
import {
  runEosBackfill,
  type EosBackfillOptions,
  type EosBackfillProgress,
  type EosBackfillState
} from './eos-backfill.js';
import { migrateDbLog, type DbLogSchemaChange } from './migrations.js';
import { configuredDbSchema } from './schema.js';
import { DatabaseWriteQueue } from './write-queue.js';

type DbModel = ModelStatic<Model<Record<string, unknown>, Record<string, unknown>>>;

export interface DbLogOptions {
  readonly serverID: number;
  readonly serverName: string;
  readonly maximumPendingWrites?: number;
  readonly onWriteError?: (error: Error) => void;
  readonly onSchemaChange?: (change: DbLogSchemaChange) => void;
  readonly resolveMatchMetadata?: (input: {
    readonly mapClassname: string;
    readonly layerClassname?: string;
  }) => Promise<{ readonly map?: string; readonly layer?: string }>;
}

export interface MatchStart {
  readonly time: Date;
  readonly dlc?: string;
  readonly mapClassname?: string;
  readonly layerClassname?: string;
  readonly map?: string;
  readonly layer?: string;
}

export interface MatchEnd {
  readonly time: Date;
  readonly winnerTeam?: number;
  readonly team1Faction?: string;
  readonly team1Unit?: string;
  readonly team1Tickets?: number;
  readonly team2Faction?: string;
  readonly team2Unit?: string;
  readonly team2Tickets?: number;
}

export interface CombatWrite {
  readonly time: Date;
  readonly woundTime?: Date;
  readonly victim: LivePlayer;
  readonly attacker?: LivePlayer;
  readonly damage?: number;
  readonly weapon?: string;
  readonly teamkill?: boolean;
}

export interface ReviveWrite extends CombatWrite {
  readonly reviver: LivePlayer;
}

export class DbLog {
  readonly #sequelize: Sequelize;
  readonly #options: DbLogOptions;
  readonly #queue: DatabaseWriteQueue;
  #models: Readonly<Record<string, DbModel>> | undefined;
  #matchID: number | undefined;
  #backfillAbort: AbortController | undefined;
  #backfillPromise: Promise<EosBackfillState> | undefined;
  readonly #persistedPlayers = new Map<EOSID, string>();
  #playerUpserts = 0;
  #playerUpsertSkips = 0;

  constructor(sequelize: Sequelize, options: DbLogOptions) {
    this.#sequelize = sequelize;
    this.#options = options;
    this.#queue = new DatabaseWriteQueue({
      ...(options.maximumPendingWrites === undefined
        ? {}
        : { maximumPending: options.maximumPendingWrites }),
      ...(options.onWriteError ? { onError: options.onWriteError } : {})
    });
  }

  get pendingWrites(): number {
    return this.#queue.pending;
  }

  get writeQueueHighWaterMark(): number {
    return this.#queue.highWaterMark;
  }

  get rejectedWrites(): number {
    return this.#queue.rejected;
  }

  get playerUpserts(): number {
    return this.#playerUpserts;
  }

  get playerUpsertSkips(): number {
    return this.#playerUpsertSkips;
  }

  get currentMatchID(): number | undefined {
    return this.#matchID;
  }

  async initialize(): Promise<number> {
    const schemaVersion = await migrateDbLog(this.#sequelize, this.#options.onSchemaChange);
    this.#models = defineModels(this.#sequelize);
    await this.#repairMissingMatchMetadata();
    await this.#model('Server').upsert({
      id: this.#options.serverID,
      name: this.#options.serverName
    });
    const unfinished = await this.#model('Match').findOne({
      where: { server: this.#options.serverID, endTime: null },
      order: [['id', 'DESC']]
    });
    this.#matchID = optionalNumber(unfinished?.get('id'));
    return schemaVersion;
  }

  async stop(): Promise<void> {
    this.#backfillAbort?.abort();
    await this.#backfillPromise;
    await this.#queue.drain();
  }

  async startEosBackfill(
    options: EosBackfillOptions,
    onProgress?: (progress: EosBackfillProgress) => void
  ): Promise<EosBackfillState> {
    if (this.#backfillPromise) return this.#backfillPromise;
    const controller = new AbortController();
    this.#backfillAbort = controller;
    const running = runEosBackfill(this.#sequelize, {
      ...options,
      signal: controller.signal,
      ...(onProgress ? { onProgress } : {})
    });
    this.#backfillPromise = running;
    try {
      return await running;
    } finally {
      if (this.#backfillPromise === running) this.#backfillPromise = undefined;
      if (this.#backfillAbort === controller) this.#backfillAbort = undefined;
    }
  }

  playerConnected(player: LivePlayer): Promise<void> {
    return this.#queue.enqueue(async () => this.#upsertPlayer(player));
  }

  startMatch(match: MatchStart): Promise<void> {
    return this.#queue.enqueue(async () => {
      if (this.#matchID !== undefined) {
        await this.#model('Match').update(
          { endTime: match.time },
          { where: { id: this.#matchID, endTime: null } }
        );
      }
      const created = await this.#model('Match').create({
        server: this.#options.serverID,
        startTime: match.time,
        ...defined(match, ['dlc', 'mapClassname', 'layerClassname', 'map', 'layer'])
      });
      this.#matchID = optionalNumber(created.get('id'));
      this.#persistedPlayers.clear();
    });
  }

  endMatch(match: MatchEnd): Promise<void> {
    return this.#queue.enqueue(async () => {
      const values = {
        endTime: match.time,
        winnernum: match.winnerTeam ?? null,
        team1faction: match.team1Faction ?? null,
        team1unit: match.team1Unit ?? null,
        team1tickets: match.team1Tickets ?? null,
        team2faction: match.team2Faction ?? null,
        team2unit: match.team2Unit ?? null,
        team2tickets: match.team2Tickets ?? null
      };
      await this.#model('Match').update(
        values,
        this.#matchID === undefined
          ? { where: { server: this.#options.serverID, endTime: null } }
          : { where: { id: this.#matchID } }
      );
      this.#matchID = undefined;
    });
  }

  tickRate(time: Date, tickRate: number): Promise<void> {
    return this.#queue.enqueue(async () => {
      await this.#model('TickRate').create({
        server: this.#options.serverID,
        match: this.#matchID ?? null,
        time,
        tickRate
      });
    });
  }

  playerCount(
    time: Date,
    players: number,
    publicQueue: number,
    reserveQueue: number
  ): Promise<void> {
    return this.#queue.enqueue(async () => {
      await this.#model('PlayerCount').create({
        server: this.#options.serverID,
        match: this.#matchID ?? null,
        time,
        players,
        publicQueue,
        reserveQueue
      });
    });
  }

  wound(event: CombatWrite): Promise<void> {
    return this.#combatWrite('Wound', event);
  }

  death(event: CombatWrite): Promise<void> {
    return this.#combatWrite('Death', event);
  }

  revive(event: ReviveWrite): Promise<void> {
    return this.#queue.enqueue(async () => {
      await this.#upsertPlayer(event.victim);
      if (event.attacker) await this.#upsertPlayer(event.attacker);
      await this.#upsertPlayer(event.reviver);
      await this.#model('Revive').create({
        ...this.#combatValues(event),
        reviver: event.reviver.steamID ?? null,
        reviverEOSID: event.reviver.eosID,
        reviverName: event.reviver.name,
        reviverTeamID: event.reviver.teamID ?? null,
        reviverSquadID: event.reviver.squadID ?? null
      });
    });
  }

  #combatWrite(model: 'Wound' | 'Death', event: CombatWrite): Promise<void> {
    return this.#queue.enqueue(async () => {
      await this.#upsertPlayer(event.victim);
      if (event.attacker) await this.#upsertPlayer(event.attacker);
      await this.#model(model).create(this.#combatValues(event));
    });
  }

  #combatValues(event: CombatWrite): Record<string, unknown> {
    return {
      server: this.#options.serverID,
      match: this.#matchID ?? null,
      time: event.time,
      woundTime: event.woundTime ?? null,
      victim: event.victim.steamID ?? null,
      victimEOSID: event.victim.eosID,
      victimName: event.victim.name,
      victimTeamID: event.victim.teamID ?? null,
      victimSquadID: event.victim.squadID ?? null,
      attacker: event.attacker?.steamID ?? null,
      attackerEOSID: event.attacker?.eosID ?? null,
      attackerName: event.attacker?.name ?? null,
      attackerTeamID: event.attacker?.teamID ?? null,
      attackerSquadID: event.attacker?.squadID ?? null,
      damage: event.damage ?? null,
      weapon: event.weapon ?? null,
      teamkill: event.teamkill ?? false
    };
  }

  async #upsertPlayer(player: LivePlayer): Promise<void> {
    if (!isEOSID(player.eosID)) throw new TypeError('DBLog player requires a valid EOS ID');
    const signature = JSON.stringify([player.steamID ?? null, player.name, player.ip ?? null]);
    if (this.#persistedPlayers.get(player.eosID) === signature) {
      this.#playerUpsertSkips += 1;
      return;
    }
    const model = this.#model('Player');
    await this.#sequelize.transaction(async (transaction) => {
      const rows = await model.findAll({
        where:
          player.steamID === undefined
            ? { eosID: player.eosID }
            : { [Op.or]: [{ eosID: player.eosID }, { steamID: player.steamID }] },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      const eosRow = rows.find((row) => row.get('eosID') === player.eosID);
      const steamRow =
        player.steamID === undefined
          ? undefined
          : rows.find((row) => row.get('steamID') === player.steamID);
      const values = {
        eosID: player.eosID,
        ...(player.steamID === undefined ? {} : { steamID: player.steamID }),
        lastName: player.name,
        ...(player.ip === undefined ? {} : { lastIP: player.ip })
      };

      if (steamRow) {
        if (eosRow && eosRow !== steamRow) {
          await eosRow.update({ eosID: null }, { transaction });
        }
        await steamRow.update(values, { transaction });
        return;
      }

      if (eosRow && (player.steamID === undefined || eosRow.get('steamID') == null)) {
        await eosRow.update(values, { transaction });
        return;
      }

      if (eosRow && player.steamID !== undefined) {
        await eosRow.update({ eosID: null }, { transaction });
      }
      await model.create(values, { transaction });
    });
    this.#persistedPlayers.set(player.eosID, signature);
    this.#playerUpserts += 1;
  }

  async #repairMissingMatchMetadata(): Promise<void> {
    const matches = await this.#model('Match').findAll({
      attributes: ['id', 'mapClassname', 'layerClassname'],
      where: { map: null, mapClassname: { [Op.ne]: null } }
    });
    const groups = new Map<
      string,
      { readonly mapClassname: string; readonly layerClassname?: string; readonly ids: number[] }
    >();
    for (const match of matches) {
      const id = optionalNumber(match.get('id'));
      const mapClassname = optionalString(match.get('mapClassname'));
      const layerClassname = optionalString(match.get('layerClassname'));
      if (id === undefined || !mapClassname) continue;
      const key = JSON.stringify([mapClassname, layerClassname ?? null]);
      const existing = groups.get(key);
      if (existing) existing.ids.push(id);
      else {
        groups.set(key, {
          mapClassname,
          ...(layerClassname ? { layerClassname } : {}),
          ids: [id]
        });
      }
    }

    for (const group of groups.values()) {
      const resolved = await this.#options.resolveMatchMetadata?.({
        mapClassname: group.mapClassname,
        ...(group.layerClassname ? { layerClassname: group.layerClassname } : {})
      });
      const map = optionalString(resolved?.map) ?? group.mapClassname;
      const layer = optionalString(resolved?.layer) ?? group.layerClassname;
      await this.#model('Match').update(
        { map, ...(layer ? { layer } : {}) },
        { where: { id: { [Op.in]: group.ids }, map: null } }
      );
    }
  }

  #model(name: string): DbModel {
    const model = this.#models?.[name];
    if (!model) throw new Error('DBLog is not initialized');
    return model;
  }
}

function defineModels(sequelize: Sequelize): Readonly<Record<string, DbModel>> {
  const common = { timestamps: false } as const;
  const id = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true };
  const schema = configuredDbSchema(sequelize);
  const define = (name: string, tableName: string, fields: Record<string, unknown>): DbModel => {
    return sequelize.define(`DBLog_${name}`, fields as never, {
      ...common,
      tableName,
      ...(schema ? { schema } : {})
    }) as DbModel;
  };
  return {
    Server: define('Server', 'DBLog_Servers', { id, name: DataTypes.STRING }),
    Match: define('Match', 'DBLog_Matches', {
      id,
      server: DataTypes.INTEGER,
      dlc: DataTypes.STRING,
      mapClassname: DataTypes.STRING,
      layerClassname: DataTypes.STRING,
      map: DataTypes.STRING,
      layer: DataTypes.STRING,
      startTime: DataTypes.DATE,
      endTime: DataTypes.DATE,
      winnernum: DataTypes.INTEGER,
      team1faction: DataTypes.STRING,
      team1unit: DataTypes.STRING,
      team1tickets: DataTypes.INTEGER,
      team2faction: DataTypes.STRING,
      team2unit: DataTypes.STRING,
      team2tickets: DataTypes.INTEGER
    }),
    TickRate: define('TickRate', 'DBLog_TickRates', {
      id,
      server: DataTypes.INTEGER,
      match: DataTypes.INTEGER,
      time: DataTypes.DATE,
      tickRate: DataTypes.FLOAT
    }),
    PlayerCount: define('PlayerCount', 'DBLog_PlayerCounts', {
      id,
      server: DataTypes.INTEGER,
      match: DataTypes.INTEGER,
      time: DataTypes.DATE,
      players: DataTypes.INTEGER,
      publicQueue: DataTypes.INTEGER,
      reserveQueue: DataTypes.INTEGER
    }),
    Player: define('Player', 'DBLog_Players', {
      id,
      eosID: { type: DataTypes.STRING, unique: true },
      steamID: { type: DataTypes.STRING, unique: true, allowNull: true },
      lastName: DataTypes.STRING,
      lastIP: DataTypes.STRING
    }),
    Wound: combatModel(sequelize, 'Wound', false),
    Death: combatModel(sequelize, 'Death', true),
    Revive: combatModel(sequelize, 'Revive', true, true)
  };
}

function combatModel(
  sequelize: Sequelize,
  name: string,
  woundTime: boolean,
  revive = false
): DbModel {
  return sequelize.define(
    `DBLog_${name}`,
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      server: DataTypes.INTEGER,
      match: DataTypes.INTEGER,
      time: DataTypes.DATE,
      ...(woundTime ? { woundTime: DataTypes.DATE } : {}),
      victim: DataTypes.STRING,
      victimEOSID: DataTypes.STRING,
      victimName: DataTypes.STRING,
      victimTeamID: DataTypes.INTEGER,
      victimSquadID: DataTypes.INTEGER,
      attacker: DataTypes.STRING,
      attackerEOSID: DataTypes.STRING,
      attackerName: DataTypes.STRING,
      attackerTeamID: DataTypes.INTEGER,
      attackerSquadID: DataTypes.INTEGER,
      damage: DataTypes.FLOAT,
      weapon: DataTypes.STRING,
      teamkill: DataTypes.BOOLEAN,
      ...(revive
        ? {
            reviver: DataTypes.STRING,
            reviverEOSID: DataTypes.STRING,
            reviverName: DataTypes.STRING,
            reviverTeamID: DataTypes.INTEGER,
            reviverSquadID: DataTypes.INTEGER
          }
        : {})
    },
    { timestamps: false, tableName: `DBLog_${name}s` }
  ) as DbModel;
}

function defined<T extends object>(value: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[String(key), value[key]]]))
  );
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isEOSID(value: EOSID): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}
