import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import Sequelize from 'sequelize';

interface SmartSwitchPlugin {
  active: boolean;
  consecutiveWins: number;
  lastWinnerTeam: number | null;
  models: { Endmatch: Sequelize.ModelStatic<Sequelize.Model> };
  prepareToMount(): Promise<void>;
  mount(): Promise<void>;
  unmount(): Promise<void>;
  onChatMessage(info: Record<string, unknown>): Promise<void>;
  maybeShuffleOnRoundEnd(info: Record<string, unknown>): Promise<boolean>;
  doubleSwitchPlayer(playerID: string): Promise<void>;
  executeQueuedPlayerSwitches(): Promise<void>;
  executeQueuedSquadSwitches(): Promise<void>;
  queuedSquads: {
    teamID: number;
    squadID: number;
    players?: Record<string, unknown>[];
    targetTeamID?: number;
  }[];
  queuedShuffle: boolean;
  recentShuffle: boolean;
  recentSwitches: { playerID: string; datetime: Date }[];
  recentDoubleSwitches: { playerID: string; datetime: Date }[];
  swappedPlayers: Set<string>;
  getSwitchSlotsPerTeam(teamID: number, players?: Record<string, unknown>[]): number;
  switchSquad(number: number, team: number): Promise<void>;
  switchPlayer(playerID: string, destination?: number): Promise<unknown>;
  autoBalanceTeams(): Promise<void>;
  randomizeSquads(report: { team1: string[]; team2: string[] }): Promise<void>;
  calculateSquadScores(groups: Record<string, unknown>[]): Promise<void>;
  onRoundEnded(info: Record<string, unknown>): Promise<void>;
  onPlayerConnected(info: Record<string, unknown>): Promise<void>;
  getSecondsFromJoin(playerID: string): number;
  getCurrentMatchId(): Promise<number | null>;
  fetchMatchDeaths(matchID: number): Promise<unknown[]>;
  fetchMatchWounds(matchID: number): Promise<unknown[]>;
  fetchMatchRevives(matchID: number): Promise<unknown[]>;
  dbLogTable(name: string): string;
  dbLogColumn(name: string): string;
  calculateSquadScoreFromMatchData(
    squad: Record<string, unknown>,
    matchData: Record<string, unknown>
  ): Record<string, unknown>;
}

async function createPlugin(overrides: Record<string, unknown> = {}) {
  const { default: SmartSwitch } = (await import(
    pathToFileURL(resolve('squad-server/plugins/smart-switch.js')).href
  )) as {
    default: new (
      server: unknown,
      options: Record<string, unknown>,
      connectors: Record<string, unknown>
    ) => SmartSwitchPlugin;
  };
  const database = new Sequelize.Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });
  const switched: string[] = [];
  const warnings: { playerID: string; message: string }[] = [];
  const server = new EventEmitter() as EventEmitter & {
    id: number;
    players: Record<string, unknown>[];
    layerHistory: { time: Date }[];
    rcon: {
      switchTeam(playerID: string): Promise<void>;
      getListPlayers(): Promise<Record<string, unknown>[]>;
      warn(playerID: string, message: string): Promise<void>;
      broadcast(): Promise<void>;
    };
    updatePlayerList(): Promise<void>;
    updateSquadList(): Promise<void>;
    removeEventListener(event: string, listener: (...arguments_: unknown[]) => void): EventEmitter;
  };
  server.id = 1;
  server.players = [{ eosID: 'eos-player', name: 'EOS Player', teamID: 1, squadID: null }];
  server.layerHistory = [{ time: new Date() }];
  server.rcon = {
    getListPlayers: async () => structuredClone(server.players),
    switchTeam: async (playerID) => {
      switched.push(playerID);
      const player = server.players.find((p) => p.eosID === playerID);
      if (player) player.teamID = player.teamID === 1 ? 2 : 1;
    },
    warn: async (playerID, message) => void warnings.push({ playerID, message }),
    broadcast: async () => undefined
  };
  server.updatePlayerList = async () => undefined;
  server.updateSquadList = async () => undefined;
  server.removeEventListener = (event, listener) => server.removeListener(event, listener);
  const discord = { channels: { fetch: async () => ({ send: async () => undefined }) } };
  const plugin = new SmartSwitch(
    server,
    {
      database: 'database',
      discordClient: 'discord',
      channelID: 'channel',
      showBroadcasts: false,
      shuffleDelaySeconds: 0,
      ...overrides
    },
    { database, discord }
  );
  await plugin.prepareToMount();
  await plugin.mount();
  return { database, plugin, server, switched, warnings };
}

test('SmartSwitch counts consecutive wins by the same player side across team flips', async () => {
  const context = await createPlugin({ consecutiveWinsThreshold: 4 });
  try {
    const teamOneRound = {
      winner: { team: 1, tickets: 100, layer: 'Test_Layer' },
      loser: { team: 2, tickets: 0 }
    };
    const teamTwoRound = {
      winner: { team: 2, tickets: 100, layer: 'Test_Layer' },
      loser: { team: 1, tickets: 0 }
    };
    assert.equal(await context.plugin.maybeShuffleOnRoundEnd(teamOneRound), false);
    assert.equal(await context.plugin.maybeShuffleOnRoundEnd(teamTwoRound), false);
    assert.equal(await context.plugin.maybeShuffleOnRoundEnd(teamOneRound), false);
    assert.equal(context.plugin.consecutiveWins, 3);
    assert.equal(context.plugin.lastWinnerTeam, 1);

    // A repeated numeric ID is the other player side after the round flip.
    assert.equal(await context.plugin.maybeShuffleOnRoundEnd(teamOneRound), false);
    assert.equal(context.plugin.consecutiveWins, 1);
    assert.equal(context.plugin.lastWinnerTeam, 1);

    await context.plugin.maybeShuffleOnRoundEnd(teamTwoRound);
    assert.equal(context.plugin.consecutiveWins, 2);
    assert.equal(context.plugin.lastWinnerTeam, 2);
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('SmartSwitch requires a separator after the command prefix', async () => {
  const context = await createPlugin();
  try {
    const admin = { eosID: 'admin-player', name: 'Admin', teamID: 1 };
    const target = { eosID: 'target-player', name: 'Valaen', teamID: 2 };
    context.server.players = [admin, target];

    const sendAdminCommand = (message: string) =>
      context.plugin.onChatMessage({ player: admin, chat: 'ChatAdmin', message });

    await sendAdminCommand('ignored now valaen');
    await sendAdminCommand('!switchnow valaen');
    await sendAdminCommand('!changenow valaen');
    assert.deepEqual(context.switched, []);

    await sendAdminCommand('!switch now valaen');
    await sendAdminCommand('!change now valaen');
    assert.deepEqual(context.switched, ['target-player', 'target-player']);
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('SmartSwitch uses EOS IDs and cancels delayed switches on unmount', async () => {
  const context = await createPlugin({ doubleSwitchDelaySeconds: 60 });
  const pending = context.plugin.doubleSwitchPlayer('eos-player');
  while (context.switched.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await context.plugin.unmount();
  await pending;
  assert.deepEqual(context.switched, ['eos-player']);
  await context.database.close();
});

test('SmartSwitch retains a queued EOS switch after an RCON failure', async () => {
  const context = await createPlugin();
  try {
    await context.plugin.models.Endmatch.create({ name: 'EOS Player', eosID: 'eos-player' });
    context.server.rcon.switchTeam = async () => {
      throw new Error('simulated RCON failure');
    };
    await context.plugin.executeQueuedPlayerSwitches();
    assert.equal(await context.plugin.models.Endmatch.count(), 1);

    context.server.rcon.switchTeam = async (playerID) => {
      context.switched.push(playerID);
      const player = context.server.players.find((p) => p.eosID === playerID);
      if (player) player.teamID = 2;
    };
    await context.plugin.executeQueuedPlayerSwitches();
    assert.deepEqual(context.switched, ['eos-player']);
    assert.equal(await context.plugin.models.Endmatch.count(), 0);
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('SmartSwitch test mode leaves queued team changes untouched', async () => {
  const context = await createPlugin({ testMode: true });
  try {
    await context.plugin.models.Endmatch.create({ name: 'EOS Player', eosID: 'eos-player' });
    await context.plugin.onRoundEnded({});
    assert.equal(await context.plugin.models.Endmatch.count(), 1);
    assert.deepEqual(context.switched, []);
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('SmartSwitch reads PLAYER_CONNECTED identity from info.player', async () => {
  const context = await createPlugin();
  try {
    await context.plugin.onPlayerConnected({ player: { eosID: 'eos-player', teamID: 1 } });
    assert.ok(context.plugin.getSecondsFromJoin('eos-player') < 1);
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('SmartSwitch squad scoring prefers EOS and falls back to Steam identity', async () => {
  const context = await createPlugin();
  try {
    const squad = {
      squadID: 1,
      players: [{ eosID: 'eos-player', steamID: 'steam-player' }, { steamID: 'legacy-player' }]
    };
    context.plugin.calculateSquadScoreFromMatchData(squad, {
      deaths: [
        { attackerEOSID: 'eos-player', attacker: 'stale-steam', teamkill: false },
        { attacker: 'legacy-player', teamkill: false }
      ],
      wounds: [{ attackerEOSID: 'eos-player', attacker: 'stale-steam', teamkill: true }],
      revives: [{ reviver: 'legacy-player' }]
    });
    assert.deepEqual((squad as Record<string, unknown>).stats, {
      kills: 2,
      teamkills: 1,
      revives: 1,
      memberCount: 2
    });
  } finally {
    await context.plugin.unmount();
    await context.database.close();
  }
});

test('SmartSwitch quotes PostgreSQL DBLog tables in the configured schema', async () => {
  const { default: SmartSwitch } = (await import(
    pathToFileURL(resolve('squad-server/plugins/smart-switch.js')).href
  )) as {
    default: new (
      server: unknown,
      options: Record<string, unknown>,
      connectors: Record<string, unknown>
    ) => SmartSwitchPlugin;
  };
  const database = new Sequelize.Sequelize({
    dialect: 'postgres',
    database: 'test',
    username: 'test',
    password: 'test',
    schema: 'squad',
    logging: false
  });
  const server = new EventEmitter() as EventEmitter & {
    id: number;
    players: unknown[];
    layerHistory: { time: Date }[];
    rcon: Record<string, unknown>;
  };
  Object.assign(server, {
    id: 6,
    players: [],
    layerHistory: [{ time: new Date() }],
    rcon: { broadcast: async () => undefined, warn: async () => undefined }
  });
  const discord = { channels: { fetch: async () => ({ send: async () => undefined }) } };
  const plugin = new SmartSwitch(
    server,
    { database: 'database', discordClient: 'discord', channelID: 'channel' },
    { database, discord }
  );
  const queries: string[] = [];
  database.query = (async (sql: string) => {
    queries.push(sql);
    return sql.includes('DBLog_Matches') ? [{ id: 44 }] : [];
  }) as typeof database.query;

  try {
    assert.equal(plugin.dbLogTable('DBLog_Matches'), '"squad"."DBLog_Matches"');
    assert.equal(plugin.dbLogColumn('endTime'), '"endTime"');
    assert.equal(await plugin.getCurrentMatchId(), 44);
    await plugin.fetchMatchDeaths(44);
    await plugin.fetchMatchWounds(44);
    await plugin.fetchMatchRevives(44);
    assert.match(queries[0] ?? '', /FROM "squad"\."DBLog_Matches"/);
    assert.match(queries[0] ?? '', /"endTime" IS NULL/);
    assert.match(queries[1] ?? '', /FROM "squad"\."DBLog_Deaths"/);
    assert.match(queries[1] ?? '', /"attackerEOSID"/);
    assert.match(queries[2] ?? '', /FROM "squad"\."DBLog_Wounds"/);
    assert.match(queries[3] ?? '', /FROM "squad"\."DBLog_Revives"/);
    assert.match(queries[3] ?? '', /"reviverEOSID"/);
  } finally {
    await database.close();
  }
});

async function auditedContext(
  t: { after(callback: () => Promise<void>): void },
  overrides: Record<string, unknown> = {}
) {
  const context = await createPlugin(overrides);
  t.after(async () => {
    await context.plugin.unmount();
    await context.database.close();
  });
  return context;
}

function rosterPlayer(eosID: string, teamID: number, extra: Record<string, unknown> = {}) {
  return { eosID, name: eosID, teamID, squadID: null, partyID: null, isLeader: false, ...extra };
}

test('SmartSwitch rejects a smaller-team request that would exceed the projected gap', async (t) => {
  const { plugin, server, switched, warnings } = await auditedContext(t);
  const player = rosterPlayer('requester', 1);
  server.players = [player, ...['a', 'b', 'c'].map((id) => rosterPlayer(id, 2))];
  assert.equal(plugin.getSwitchSlotsPerTeam(1), 0);
  await plugin.onChatMessage({ player, chat: 'ChatAll', message: '!switch' });
  assert.deepEqual(switched, []);
  assert.match(warnings[0]?.message ?? '', /would be too unbalanced/);
});

test('SmartSwitch permits an explicit ordinary party-member request without moving its leader', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  const member = rosterPlayer('member', 1, { partyID: 0, squadID: 1 });
  server.players = [
    rosterPlayer('leader', 1, { partyID: 0, squadID: 1, isLeader: true }),
    member,
    ...['a', 'b', 'c'].map((id) => rosterPlayer(id, 2))
  ];
  await plugin.onChatMessage({ player: member, chat: 'ChatAll', message: '!switch' });
  assert.deepEqual(switched, ['member']);
  assert.equal(server.players[0]?.teamID, 1);
  assert.equal(plugin.recentSwitches[0]?.playerID, 'member');
});

test('SmartSwitch checks full-party capacity for a leader request', async (t) => {
  const { plugin, server, switched, warnings } = await auditedContext(t);
  const leader = rosterPlayer('leader', 1, { partyID: 0, squadID: 1, isLeader: true });
  server.players = [
    leader,
    rosterPlayer('member', 1, { partyID: 0, squadID: 1 }),
    ...['a', 'b'].map((id) => rosterPlayer(id, 2))
  ];
  await plugin.onChatMessage({ player: leader, chat: 'ChatAll', message: '!switch' });
  assert.deepEqual(switched, []);
  assert.match(warnings[0]?.message ?? '', /Not enough room.*entire party/);
});

test('SmartSwitch whole-squad requests expand a party across squads and skip server-moved members', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = [
    rosterPlayer('leader', 1, { partyID: 0, squadID: 1, isLeader: true }),
    rosterPlayer('member', 1, { partyID: 0, squadID: 2 })
  ];
  server.rcon.switchTeam = async (id) => {
    switched.push(id);
    for (const player of server.players) player.teamID = 2;
  };
  await plugin.switchSquad(1, 1);
  assert.deepEqual(switched, ['leader']);
  assert.ok(server.players.every((player) => player.teamID === 2));
  assert.deepEqual(
    plugin.recentSwitches.map((entry) => entry.playerID),
    ['leader', 'member']
  );
});

test('SmartSwitch deduplicates overlapping player and squad queues for one round', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = [rosterPlayer('one', 1, { squadID: 1 }), rosterPlayer('two', 1, { squadID: 1 })];
  plugin.queuedSquads = [{ teamID: 1, squadID: 1 }];
  await plugin.models.Endmatch.create({ name: 'one', eosID: 'one' });
  await plugin.onRoundEnded({});
  assert.deepEqual(switched, ['one', 'two']);
  assert.equal(await plugin.models.Endmatch.count(), 0);
  assert.deepEqual(plugin.queuedSquads, []);
});

test('SmartSwitch retains partial squad destinations and does not toggle a completed member on retry', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = [rosterPlayer('one', 1, { squadID: 1 }), rosterPlayer('two', 1, { squadID: 1 })];
  plugin.queuedSquads = [{ teamID: 1, squadID: 1 }];
  const normal = server.rcon.switchTeam;
  server.rcon.switchTeam = async (id) => {
    if (id === 'two') throw new Error('offline failure');
    await normal(id);
  };
  await plugin.executeQueuedSquadSwitches();
  assert.deepEqual(switched, ['one']);
  assert.equal(plugin.queuedSquads.length, 1);
  assert.equal(plugin.queuedSquads[0]?.targetTeamID, 2);
  server.rcon.switchTeam = normal;
  await plugin.executeQueuedSquadSwitches();
  assert.deepEqual(switched, ['one', 'two']);
  assert.deepEqual(plugin.queuedSquads, []);
});

test('SmartSwitch preserves queued shuffle and player rows on empty roster, without lockout', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  plugin.queuedShuffle = true;
  await plugin.models.Endmatch.create({ name: 'EOS Player', eosID: 'eos-player' });
  server.rcon.getListPlayers = async () => [];
  await plugin.onRoundEnded({});
  assert.equal(plugin.queuedShuffle, true);
  assert.equal(await plugin.models.Endmatch.count(), 1);
  assert.equal(plugin.recentShuffle, false);
  assert.deepEqual(switched, []);
});

test('SmartSwitch does not delete an inactive queue or consume cooldown on failed confirmation', async (t) => {
  const { plugin, server } = await auditedContext(t);
  await plugin.models.Endmatch.create({ name: 'EOS Player', eosID: 'eos-player' });
  plugin.active = false;
  await plugin.executeQueuedPlayerSwitches();
  assert.equal(await plugin.models.Endmatch.count(), 1);
  plugin.active = true;
  server.rcon.switchTeam = async () => undefined;
  await plugin.executeQueuedPlayerSwitches();
  assert.equal(await plugin.models.Endmatch.count(), 1);
  assert.deepEqual(plugin.recentSwitches, []);
});

test('SmartSwitch clears a verified persisted destination without another toggle', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = [rosterPlayer('one', 2)];
  await plugin.models.Endmatch.create({ name: 'one', eosID: 'one', targetTeamID: 2 });
  await plugin.executeQueuedPlayerSwitches();
  assert.deepEqual(switched, []);
  assert.equal(await plugin.models.Endmatch.count(), 0);
});

test('SmartSwitch balancer moves an eligible individual instead of splitting an oversized party', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = [
    ...['p1', 'p2', 'p3'].map((id) => rosterPlayer(id, 1, { partyID: 0, squadID: 1 })),
    rosterPlayer('solo', 1),
    rosterPlayer('a', 2),
    rosterPlayer('b', 2)
  ];
  await plugin.autoBalanceTeams();
  assert.deepEqual(switched, ['solo']);
  assert.ok(
    server.players.filter((player) => player.partyID === 0).every((player) => player.teamID === 1)
  );
});

test('SmartSwitch leaves residual imbalance when no entire party can improve it', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = [
    ...['p1', 'p2', 'p3', 'p4'].map((id) => rosterPlayer(id, 1, { partyID: 0, squadID: 1 })),
    rosterPlayer('a', 2)
  ];
  await plugin.autoBalanceTeams();
  assert.deepEqual(switched, []);
});

test('SmartSwitch leader request moves the entire party and records each verified cooldown', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  const leader = rosterPlayer('leader', 1, { partyID: 0, isLeader: true });
  server.players = [
    rosterPlayer('member', 1, { partyID: 0 }),
    leader,
    rosterPlayer('solo', 1),
    rosterPlayer('opponent', 2)
  ];
  server.rcon.switchTeam = async (id) => {
    switched.push(id);
    for (const player of server.players.filter((p) => p.partyID === 0)) player.teamID = 2;
  };
  await plugin.onChatMessage({ player: leader, chat: 'ChatAll', message: '!switch' });
  assert.deepEqual(switched, ['leader']);
  assert.equal(plugin.recentSwitches.length, 2);
});

test('SmartSwitch refuses absent or ambiguous party leaders', async (t) => {
  const { plugin, server, switched, warnings } = await auditedContext(t);
  for (const flags of [
    [false, false],
    [true, true]
  ]) {
    server.players = [
      rosterPlayer('one', 1, { partyID: 0, isLeader: flags[0] }),
      rosterPlayer('two', 1, { partyID: 0, isLeader: flags[1] })
    ];
    await plugin.onChatMessage({ player: server.players[0], chat: 'ChatAll', message: '!switch' });
  }
  assert.deepEqual(switched, []);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => /missing or ambiguous/.test(w.message)));
});

test('SmartSwitch retries the same shuffle destinations after a partial failure', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = ['one', 'two', 'three', 'four'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {};
  const normal = server.rcon.switchTeam;
  server.rcon.switchTeam = async (id) => {
    if (id === 'three') throw new Error('offline failure');
    await normal(id);
  };
  await assert.rejects(plugin.randomizeSquads({ team1: [], team2: [] }));
  server.rcon.switchTeam = normal;
  await plugin.randomizeSquads({ team1: [], team2: [] });
  assert.deepEqual(switched, ['one', 'three']);
  assert.equal(server.players[0]?.teamID, 2);
});
