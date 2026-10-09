import Sequelize from 'sequelize';

import BasePlugin from './base-plugin.js';
import DBLog from './db-log.js';

const { DataTypes, Op } = Sequelize;

const STATE_SEEDING = 'seeding';
const STATE_UNLOCKED_SQUAD_LEADER = 'unlocked_squad_leader';

const PHASE_PRELIVE = 'prelive';
const PHASE_SEEDING = 'seeding';
const PHASE_LIVE = 'live';

const EVALUATION_INTERVAL_MS = 30 * 1000;
const FLUSH_INTERVAL_MS = 60 * 1000;
const STALE_SESSION_RECOVERY_BUFFER_MS = 15 * 1000;

function toIsoString(value) {
  if (!value) return null;

  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ serializationError: error.message });
  }
}

function buildSessionKey(state, eosID) {
  return `${state}:${eosID}`;
}

function buildSquadKey(teamID, squadID) {
  return `${teamID}:${squadID}`;
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  return fallback;
}

function normalizeInteger(value, fallback = null) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fieldName) {
  const parsed = normalizeInteger(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater.`);
  }

  return parsed;
}

function normalizePositiveInteger(value, fieldName) {
  const parsed = normalizeInteger(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be greater than 0.`);
  }

  return parsed;
}

function normalizeEligiblePlayer(player, extra = {}) {
  return {
    eosID: player.eosID,
    steamID: player.steamID || null,
    name: player.name || null,
    teamID: player.teamID ?? null,
    squadID: player.squadID ?? null,
    role: player.role || null,
    isLeader: Boolean(player.isLeader),
    ...extra
  };
}

export default class PlayerStateTracker extends BasePlugin {
  static get description() {
    return (
      'Tracks durable per-player time spent in built-in states such as <code>seeding</code> ' +
      'and <code>unlocked_squad_leader</code>, persisting factual state sessions through an ' +
      'explicit Sequelize connector.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      database: {
        required: false,
        description:
          'Sequelize connector name. If omitted, the DBLog connector is used temporarily for backward compatibility.',
        connector: 'sequelize',
        default: null
      },
      seedingMinPlayers: {
        required: false,
        description: 'Minimum player count required before seeding can start for the current round.',
        default: 1
      },
      liveTarget: {
        required: false,
        description: 'Player count at or above which the server is considered live and seeding closes.',
        default: 70
      },
      seedingReopenBelow: {
        required: false,
        description:
          'Player count that must be crossed downward before seeding can reopen in the same round.',
        default: 65
      },
      seedingReopenDelayMinutes: {
        required: false,
        description:
          'Continuous minutes below seedingReopenBelow required before seeding reopens in the same round.',
        default: 2
      },
      minUnlockedSquadSize: {
        required: false,
        description:
          'Minimum squad size required for unlocked squad leaders to qualify during live play.',
        default: 3
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.DBLogPlugin = null;
    this.database = null;
    this.models = {};

    this.activeSessions = new Map();
    this.pendingClosedSessions = new Set();

    this.serverPhase = {
      current: PHASE_PRELIVE,
      hasReachedLiveThisRound: false,
      belowReopenSince: null
    };

    this.operationQueue = Promise.resolve();
    this.queuedOperationLabels = new Set();
    this.evaluationTimer = null;
    this.flushTimer = null;
    this.active = false;

    this.onNewGame = this.onNewGame.bind(this);
    this.onRoundEnded = this.onRoundEnded.bind(this);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
    this.runEvaluationTick = this.runEvaluationTick.bind(this);
    this.runFlushTick = this.runFlushTick.bind(this);
  }

  async mount() {
    this.validateOptions();
    this.DBLogPlugin = this.server.plugins.find((plugin) => plugin instanceof DBLog);
    this.database = this.options.database || this.DBLogPlugin?.options?.database;

    if (!this.database) {
      throw new Error(
        `${this.constructor.name} requires a database connector or an enabled DBLog fallback.`
      );
    }
    if (!this.options.database) {
      this.log(
        1,
        'Using the DBLog database fallback is deprecated; configure PlayerStateTracker.database explicitly.'
      );
    }

    this.initializeModels();
    await this.syncModels();
    await this.recoverStaleDatabaseState();

    await this.enqueueOperation('initial-evaluation', async () => {
      await this.evaluateStateSnapshot();
      await this.flushStateToDatabase();
    });

    this.active = true;
    this.server.on('NEW_GAME', this.onNewGame);
    this.server.on('ROUND_ENDED', this.onRoundEnded);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);

    this.evaluationTimer = setInterval(this.runEvaluationTick, EVALUATION_INTERVAL_MS);
    this.flushTimer = setInterval(this.runFlushTick, FLUSH_INTERVAL_MS);

    this.log(1, 'Mounted.');
  }

  async unmount() {
    this.active = false;
    if (this.evaluationTimer) clearInterval(this.evaluationTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.evaluationTimer = null;
    this.flushTimer = null;

    this.detachListener(this.server, 'NEW_GAME', this.onNewGame);
    this.detachListener(this.server, 'ROUND_ENDED', this.onRoundEnded);
    this.detachListener(this.server, 'PLAYER_DISCONNECTED', this.onPlayerDisconnected);

    await this.enqueueOperation('unmount-close', async () => {
      await this.closeAllSessions('plugin_unmount', new Date());
      await this.flushStateToDatabase();
    });

    this.log(1, 'Un-mounted.');
  }

  validateOptions() {
    this.options.seedingMinPlayers = normalizeNonNegativeInteger(
      this.options.seedingMinPlayers,
      'seedingMinPlayers'
    );
    this.options.liveTarget = normalizePositiveInteger(this.options.liveTarget, 'liveTarget');
    this.options.seedingReopenBelow = normalizeNonNegativeInteger(
      this.options.seedingReopenBelow,
      'seedingReopenBelow'
    );
    this.options.seedingReopenDelayMinutes = normalizePositiveInteger(
      this.options.seedingReopenDelayMinutes,
      'seedingReopenDelayMinutes'
    );
    this.options.minUnlockedSquadSize = normalizePositiveInteger(
      this.options.minUnlockedSquadSize,
      'minUnlockedSquadSize'
    );
  }

  initializeModels() {
    this.models.Session = this.database.define(
      'PlayerStateTracker_Session',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        server: {
          type: DataTypes.INTEGER,
          allowNull: false
        },
        match: {
          type: DataTypes.INTEGER
        },
        state: {
          type: DataTypes.STRING,
          allowNull: false
        },
        eosID: {
          type: DataTypes.STRING,
          allowNull: false
        },
        steamID: {
          type: DataTypes.STRING
        },
        lastName: {
          type: DataTypes.STRING
        },
        openedAt: {
          type: DataTypes.DATE,
          allowNull: false
        },
        closedAt: {
          type: DataTypes.DATE
        },
        lastAccruedAt: {
          type: DataTypes.DATE,
          allowNull: false
        },
        lastFlushedAt: {
          type: DataTypes.DATE,
          allowNull: false
        },
        rawMilliseconds: {
          type: DataTypes.BIGINT,
          allowNull: false,
          defaultValue: 0
        },
        openReason: {
          type: DataTypes.STRING
        },
        closeReason: {
          type: DataTypes.STRING
        },
        metadata: {
          type: DataTypes.TEXT
        }
      },
      {
        timestamps: false,
        indexes: [
          { fields: ['server', 'state', 'openedAt'] },
          { fields: ['server', 'closedAt'] },
          { fields: ['eosID', 'state', 'openedAt'] }
        ]
      }
    );
  }

  async syncModels() {
    await this.models.Session.sync();
  }

  async recoverStaleDatabaseState() {
    const now = new Date();
    const serverID = this.getServerID();
    const recoveryCapMs = FLUSH_INTERVAL_MS + STALE_SESSION_RECOVERY_BUFFER_MS;

    const staleSessions = await this.models.Session.findAll({
      where: {
        server: serverID,
        closedAt: {
          [Op.is]: null
        }
      }
    });

    for (const staleSession of staleSessions) {
      const lastFlushedAt = staleSession.lastFlushedAt
        ? new Date(staleSession.lastFlushedAt)
        : new Date(staleSession.openedAt);
      const recoveredCloseAt = new Date(
        Math.min(now.getTime(), lastFlushedAt.getTime() + recoveryCapMs)
      );
      const recoveredDeltaMs = Math.max(0, recoveredCloseAt.getTime() - lastFlushedAt.getTime());

      await staleSession.update({
        closedAt: recoveredCloseAt,
        lastAccruedAt: recoveredCloseAt,
        rawMilliseconds: Number(staleSession.rawMilliseconds || 0) + recoveredDeltaMs,
        closeReason: 'restart_recovery'
      });
    }
  }

  async onNewGame(info) {
    await this.enqueueOperation('new-game', async () => {
      const eventTime = info?.time ? new Date(info.time) : new Date();
      await this.closeAllSessions('new_game', eventTime);
      this.resetPhase();
      await this.evaluateStateSnapshot();
      await this.flushStateToDatabase();
    });
  }

  async onRoundEnded(info) {
    await this.enqueueOperation('round-ended', async () => {
      const eventTime = info?.time ? new Date(info.time) : new Date();
      await this.closeAllSessions('round_ended', eventTime);
      await this.flushStateToDatabase();
    });
  }

  async onPlayerDisconnected(info) {
    await this.enqueueOperation('player-disconnected', async () => {
      const eosID = info?.player?.eosID || info?.eosID;
      if (!eosID) return;

      const eventTime = info?.time ? new Date(info.time) : new Date();
      const closedSessions = await this.closeSessionsForPlayer(
        eosID,
        'player_disconnected',
        eventTime
      );
      await this.flushSessions(closedSessions);
    });
  }

  runEvaluationTick() {
    if (!this.active) return;
    this.enqueueUniqueOperation('evaluation', async () => {
      await this.evaluateStateSnapshot();
    }).catch(() => {});
  }

  runFlushTick() {
    if (!this.active) return;
    this.enqueueUniqueOperation('flush', async () => {
      await this.flushStateToDatabase();
    }).catch(() => {});
  }

  enqueueUniqueOperation(label, operation) {
    if (this.queuedOperationLabels.has(label)) {
      return Promise.resolve(false);
    }

    this.queuedOperationLabels.add(label);

    return this.enqueueOperation(label, async () => {
      try {
        await operation();
      } finally {
        this.queuedOperationLabels.delete(label);
      }
    });
  }

  enqueueOperation(label, operation) {
    const run = this.operationQueue
      .catch(() => {})
      .then(async () => {
        try {
          await operation();
        } catch (error) {
          this.log(1, `${label} failed: ${error.message}`);
          throw error;
        }
      });

    this.operationQueue = run.catch(() => {});
    return run;
  }

  async evaluateStateSnapshot() {
    const snapshot = await this.buildSnapshot();

    if (!snapshot) return;

    const now = new Date();

    this.accrueActiveSessionsUntil(now);
    this.updateServerPhase(snapshot.playerCount, now);

    const eligibility = this.buildEligibility(snapshot);
    await this.reconcileSessions(eligibility, now, snapshot);
  }

  async buildSnapshot() {
    try {
      const playersRaw = Array.isArray(this.server.players) ? this.server.players : [];
      const squadsRaw = Array.isArray(this.server.squads) ? this.server.squads : [];

      const players = playersRaw
        .filter((player) => player?.eosID)
        .map((player) => ({
          ...player,
          teamID: normalizeInteger(player.teamID),
          squadID: normalizeInteger(player.squadID),
          isLeader: Boolean(player.isLeader)
        }));

      const squads = squadsRaw.map((squad) => ({
        ...squad,
        teamID: normalizeInteger(squad.teamID),
        squadID: normalizeInteger(squad.squadID),
        size: normalizeInteger(squad.size, 0) || 0,
        locked: toBoolean(squad.locked, false)
      }));

      return {
        capturedAt: new Date(),
        playerCount: players.length,
        players,
        squads
      };
    } catch (error) {
      this.log(1, `Failed to build snapshot: ${error.message}`);
      return null;
    }
  }

  updateServerPhase(playerCount, now) {
    const wasPhase = this.serverPhase.current;

    if (playerCount >= this.options.liveTarget) {
      this.serverPhase.current = PHASE_LIVE;
      this.serverPhase.hasReachedLiveThisRound = true;
      this.serverPhase.belowReopenSince = null;
    } else if (!this.serverPhase.hasReachedLiveThisRound) {
      if (
        this.serverPhase.current === PHASE_SEEDING ||
        playerCount >= this.options.seedingMinPlayers
      ) {
        this.serverPhase.current = PHASE_SEEDING;
      } else {
        this.serverPhase.current = PHASE_PRELIVE;
      }
    } else if (this.serverPhase.current === PHASE_LIVE) {
      if (playerCount < this.options.seedingReopenBelow) {
        if (!this.serverPhase.belowReopenSince) {
          this.serverPhase.belowReopenSince = new Date(now);
        }

        if (
          playerCount >= this.options.seedingMinPlayers &&
          now.getTime() - this.serverPhase.belowReopenSince.getTime() >=
            this.getSeedingReopenDelayMilliseconds()
        ) {
          this.serverPhase.current = PHASE_SEEDING;
        }
      } else {
        this.serverPhase.belowReopenSince = null;
      }
    } else if (this.serverPhase.current === PHASE_SEEDING) {
      if (playerCount >= this.options.liveTarget) {
        this.serverPhase.current = PHASE_LIVE;
        this.serverPhase.belowReopenSince = null;
      }
    }

    if (wasPhase !== this.serverPhase.current) {
      this.log(
        1,
        `Server phase changed ${wasPhase} -> ${this.serverPhase.current} at playerCount=${playerCount}`
      );
    }
  }

  getSeedingReopenDelayMilliseconds() {
    return this.options.seedingReopenDelayMinutes * 60 * 1000;
  }

  buildEligibility(snapshot) {
    const eligibility = new Map([
      [STATE_SEEDING, new Map()],
      [STATE_UNLOCKED_SQUAD_LEADER, new Map()]
    ]);

    if (this.serverPhase.current === PHASE_SEEDING) {
      for (const player of snapshot.players) {
        eligibility.get(STATE_SEEDING).set(
          player.eosID,
          normalizeEligiblePlayer(player, {
            qualification: 'server_phase_seeding',
            playerCount: snapshot.playerCount,
            phase: this.serverPhase.current
          })
        );
      }
    }

    if (this.serverPhase.current === PHASE_LIVE) {
      const squadsByLeader = new Map();

      for (const player of snapshot.players) {
        if (
          !player.isLeader ||
          !Number.isFinite(player.teamID) ||
          !Number.isFinite(player.squadID)
        ) {
          continue;
        }

        squadsByLeader.set(buildSquadKey(player.teamID, player.squadID), player);
      }

      for (const squad of snapshot.squads) {
        if (squad.locked) continue;
        if (squad.size < this.options.minUnlockedSquadSize) continue;

        const leader = squadsByLeader.get(buildSquadKey(squad.teamID, squad.squadID));
        if (!leader?.eosID) continue;

        eligibility.get(STATE_UNLOCKED_SQUAD_LEADER).set(
          leader.eosID,
          normalizeEligiblePlayer(leader, {
            qualification: 'live_unlocked_squad_leader',
            playerCount: snapshot.playerCount,
            phase: this.serverPhase.current,
            squadName: squad.squadName || null,
            squadSize: squad.size,
            squadLocked: squad.locked,
            teamName: squad.teamName || null
          })
        );
      }
    }

    return eligibility;
  }

  async reconcileSessions(eligibility, now, snapshot) {
    const eligibleKeys = new Set();

    for (const [state, players] of eligibility.entries()) {
      for (const [eosID, details] of players.entries()) {
        const key = buildSessionKey(state, eosID);
        eligibleKeys.add(key);

        if (this.activeSessions.has(key)) continue;

        const session = this.createSession(details, state, now, snapshot);
        this.activeSessions.set(key, session);
        await this.persistSessionCreate(session);
      }
    }

    for (const session of [...this.activeSessions.values()]) {
      const key = buildSessionKey(session.state, session.eosID);
      if (eligibleKeys.has(key)) continue;
      await this.closeSession(session, 'state_exit', now);
    }
  }

  createSession(details, state, now, snapshot) {
    return {
      key: buildSessionKey(state, details.eosID),
      state,
      eosID: details.eosID,
      steamID: details.steamID || null,
      lastName: details.name || null,
      openedAt: new Date(now),
      closedAt: null,
      lastAccruedAt: new Date(now),
      lastFlushedAt: new Date(now),
      rawMilliseconds: 0,
      openReason: 'state_entered',
      closeReason: null,
      dirty: true,
      dbId: null,
      match: this.getBestKnownMatchID(),
      metadata: {
        openingContext: details,
        phase: this.serverPhase.current,
        playerCount: snapshot.playerCount,
        openedAt: toIsoString(now)
      }
    };
  }

  getBestKnownMatchID() {
    return this.DBLogPlugin?.match?.id || null;
  }

  async resolveCurrentMatchID() {
    if (this.DBLogPlugin?.match?.id) return this.DBLogPlugin.match.id;
    if (!this.DBLogPlugin?.models?.Match) return null;

    const openMatch = await this.DBLogPlugin.models.Match.findOne({
      where: {
        server: this.getServerID(),
        endTime: null
      }
    });

    return openMatch?.id || null;
  }

  async persistSessionCreate(session, currentMatchID = null) {
    try {
      const matchID = session.match ?? currentMatchID ?? (await this.resolveCurrentMatchID());
      const row = await this.models.Session.create({
        server: this.getServerID(),
        match: matchID,
        state: session.state,
        eosID: session.eosID,
        steamID: session.steamID,
        lastName: session.lastName,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        lastAccruedAt: session.lastAccruedAt,
        lastFlushedAt: session.lastFlushedAt,
        rawMilliseconds: session.rawMilliseconds,
        openReason: session.openReason,
        closeReason: session.closeReason,
        metadata: safeJsonStringify(session.metadata)
      });

      session.dbId = row.id;
      session.match = matchID;
      session.dirty = true;
    } catch (error) {
      this.log(1, `Failed to create session row for ${session.key}: ${error.message}`);
    }
  }

  accrueActiveSessionsUntil(now) {
    for (const session of this.activeSessions.values()) {
      this.accrueSessionUntil(session, now);
    }
  }

  accrueSessionUntil(session, now) {
    if (now.getTime() <= session.lastAccruedAt.getTime()) return;

    const rawMilliseconds = Math.max(0, now.getTime() - session.lastAccruedAt.getTime());

    session.rawMilliseconds += rawMilliseconds;
    session.lastAccruedAt = new Date(now);
    session.dirty = true;
  }

  async closeSession(session, reason, when) {
    const closeAt = new Date(Math.max(when.getTime(), session.lastAccruedAt.getTime()));
    this.accrueSessionUntil(session, closeAt);

    session.closedAt = closeAt;
    session.closeReason = reason;
    session.dirty = true;

    this.activeSessions.delete(session.key);
    this.pendingClosedSessions.add(session);
  }

  async closeSessionsForPlayer(eosID, reason, when) {
    const closedSessions = [];

    for (const session of [...this.activeSessions.values()]) {
      if (session.eosID !== eosID) continue;
      await this.closeSession(session, reason, when);
      closedSessions.push(session);
    }

    return closedSessions;
  }

  async closeAllSessions(reason, when) {
    for (const session of [...this.activeSessions.values()]) {
      await this.closeSession(session, reason, when);
    }
  }

  async flushStateToDatabase() {
    await this.flushSessions();
  }

  async flushSessions(sessions = null) {
    const allSessions = sessions || [
      ...this.activeSessions.values(),
      ...this.pendingClosedSessions
    ];
    const dirtySessions = allSessions.filter((session) => !session.dbId || session.dirty);

    if (dirtySessions.length === 0) {
      this.clearCleanPendingClosedSessions();
      return;
    }

    const needsMatchID = dirtySessions.some((session) => session.match == null);
    const currentMatchID = needsMatchID ? await this.resolveCurrentMatchID() : null;

    for (const session of dirtySessions) {
      await this.flushSingleSession(session, currentMatchID);
    }

    this.clearCleanPendingClosedSessions();
  }

  clearCleanPendingClosedSessions() {
    for (const session of [...this.pendingClosedSessions]) {
      if (session.dirty) continue;
      this.pendingClosedSessions.delete(session);
    }
  }

  async flushSingleSession(session, currentMatchID = null) {
    if (!session.dbId) {
      await this.persistSessionCreate(session, currentMatchID);
    }

    if (!session.dbId) return;
    if (!session.dirty) return;

    const matchID = session.match ?? currentMatchID;
    const flushedAt = new Date();

    await this.models.Session.update(
      {
        match: matchID,
        steamID: session.steamID,
        lastName: session.lastName,
        closedAt: session.closedAt,
        lastAccruedAt: session.lastAccruedAt,
        lastFlushedAt: flushedAt,
        rawMilliseconds: session.rawMilliseconds,
        closeReason: session.closeReason,
        metadata: safeJsonStringify(session.metadata)
      },
      {
        where: {
          id: session.dbId
        }
      }
    );

    session.match = matchID;
    session.lastFlushedAt = flushedAt;
    session.dirty = false;
  }

  resetPhase() {
    this.serverPhase = {
      current: PHASE_PRELIVE,
      hasReachedLiveThisRound: false,
      belowReopenSince: null
    };
  }

  getServerID() {
    return this.DBLogPlugin?.options?.overrideServerID || this.server.id;
  }

  detachListener(target, eventName, handler) {
    if (!target || !eventName || !handler) return;

    if (typeof target.off === 'function') {
      target.off(eventName, handler);
      return;
    }

    if (typeof target.removeListener === 'function') {
      target.removeListener(eventName, handler);
      return;
    }

    if (typeof target.removeEventListener === 'function') {
      target.removeEventListener(eventName, handler);
    }
  }

  log(level, message) {
    this.verbose(level, message);
  }
}
