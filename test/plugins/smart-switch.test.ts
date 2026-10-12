import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import Sequelize from 'sequelize';

interface SmartSwitchPlugin {
  active: boolean;
  onNewGame(): void;
  runSmartShuffle(
    info: Record<string, unknown>,
    manual: boolean,
    difference: string
  ): Promise<boolean>;
  sendShuffleOutcome(summary: Record<string, unknown>): Promise<void>;
  sendReshuffleReport(...args: unknown[]): Promise<void>;
  sendDiscordMessage(message: {
    embed: { title: string; description?: string; fields: { name: string; value: string }[] };
  }): Promise<void>;
  verbose(level: number, message: string): void;
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
      getSquads(): Promise<Record<string, unknown>[]>;
      getMutationVersion?(): number | null;
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
    getSquads: async () => [],
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

test('SmartSwitch consumes an empty-roster shuffle attempt but preserves individual queues', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  plugin.queuedShuffle = true;
  await plugin.models.Endmatch.create({ name: 'EOS Player', eosID: 'eos-player' });
  server.rcon.getListPlayers = async () => [];
  await plugin.onRoundEnded({});
  assert.equal(plugin.queuedShuffle, false);
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

test('SmartSwitch ends a failed shuffle plan and does not replay it next round', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = ['one', 'two', 'three', 'four'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const normal = server.rcon.switchTeam;
  server.rcon.switchTeam = async (id) => {
    if (id === 'three') throw new Error('offline failure');
    await normal(id);
  };
  plugin.queuedShuffle = true;
  await plugin.onRoundEnded({});
  assert.deepEqual(switched, ['one']);
  assert.equal(plugin.queuedShuffle, false);
  assert.equal(plugin.consecutiveWins, 0);
  server.rcon.switchTeam = normal;
  plugin.onNewGame();
  await plugin.onRoundEnded({});
  assert.deepEqual(switched, ['one']);
});

test('SmartSwitch skips ambiguous parties and moves independent safe groups', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = [
    rosterPlayer('bad-one', 1, { partyID: 0, squadID: 1, isLeader: true }),
    rosterPlayer('bad-two', 1, { partyID: 0, squadID: 2, isLeader: true }),
    ...['safe-one', 'safe-two', 'safe-three'].map((id) => rosterPlayer(id, 1)),
    ...['opposite-one', 'opposite-two', 'opposite-three', 'opposite-four', 'opposite-five'].map(
      (id) => rosterPlayer(id, 2)
    )
  ];
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.ok(switched.includes('opposite-one'));
  assert.ok(switched.includes('safe-one'));
  assert.ok(!switched.some((id) => id.startsWith('bad')));
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.skipped, 2);
  assert.ok(Number(reports[0]?.moved) > 0);
});

test('SmartSwitch reports a departed planned player and continues independent groups', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = ['one', 'two', 'three', 'four'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {
    server.players = server.players.filter((p) => p.eosID !== 'one');
  };
  plugin.sendReshuffleReport = async () => {};
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.ok(!switched.includes('one'));
  assert.ok(switched.includes('three'));
  assert.equal(reports[0]?.skipped, 0);
  assert.equal(reports[0]?.departed, 1);
});

test('SmartSwitch emits one result report for success, skips and fatal roster failure', async (t) => {
  for (const scenario of ['success', 'skip', 'fatal']) {
    const { plugin, server } = await auditedContext(t);
    server.players =
      scenario === 'skip'
        ? ['a', 'b']
            .map((id) => rosterPlayer(id, 1, { partyID: 0 }))
            .concat(['c', 'd'].map((id) => rosterPlayer(id, 2, { partyID: 1 })))
        : ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
    if (scenario === 'fatal') server.rcon.getListPlayers = async () => [];
    plugin.calculateSquadScores = async () => {};
    let detailedReports = 0;
    plugin.sendReshuffleReport = async () => {
      detailedReports++;
    };
    const embeds: {
      title: string;
      description?: string;
      fields: { name: string; value: string }[];
    }[] = [];
    plugin.sendDiscordMessage = async ({ embed }) => {
      embeds.push(embed);
    };
    await plugin.runSmartShuffle({}, true, 'Manual');
    assert.equal(embeds.filter((embed) => embed.title === 'Shuffle results').length, 1);
    assert.equal(detailedReports, 1);
    if (scenario !== 'success') assert.ok(embeds[0]?.fields[0]?.value);
  }
});

test('SmartSwitch cleanup and original failure survive Discord reporting errors', async (t) => {
  const { plugin, server } = await auditedContext(t);
  server.rcon.getListPlayers = async () => [];
  plugin.consecutiveWins = 3;
  plugin.sendDiscordMessage = async () => {
    throw new Error('Discord unavailable');
  };
  const logs: string[] = [];
  plugin.verbose = (_level, message) => {
    logs.push(message);
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.equal(plugin.consecutiveWins, 0);
  assert.equal(plugin.lastWinnerTeam, null);
  assert.match(logs.at(-1) ?? '', /Player roster is empty/);
  assert.match(logs.at(-1) ?? '', /Discord unavailable/);
});

test('SmartSwitch consumes queued and automatic triggers once and cancels a delayed attempt at new game', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {
    plugin.onNewGame();
  };
  plugin.sendReshuffleReport = async () => {};
  plugin.queuedShuffle = true;
  plugin.consecutiveWins = 3;
  await Promise.all([
    plugin.onRoundEnded({ time: 'same-round' }),
    plugin.onRoundEnded({ time: 'same-round' })
  ]);
  assert.deepEqual(switched, []);
  assert.equal(plugin.queuedShuffle, false);
  assert.equal(plugin.consecutiveWins, 0);
});

test('SmartSwitch result fields stay within Discord limits', async (t) => {
  const { plugin } = await auditedContext(t);
  const lengths: number[] = [];
  plugin.sendDiscordMessage = async ({ embed }) => {
    lengths.push(...embed.fields.map((field) => field.value.length));
  };
  await plugin.sendShuffleOutcome({
    trigger: 'queued',
    planned: 100,
    moved: 0,
    skipped: 100,
    failed: 0,
    groups: Array.from({ length: 100 }, () => ({
      teamID: 1,
      players: ['x'],
      outcome: 'skipped',
      reason: 'long reason '.repeat(150)
    }))
  });
  assert.ok(lengths.length > 1);
  assert.ok(lengths.every((length) => length <= 1024));
});

test('SmartSwitch config disables shuffle and balancing while preserving manual switches and queues', async (t) => {
  const { plugin, server, switched, warnings } = await auditedContext(t, {
    shuffleEnabled: false,
    consecutiveWinsThreshold: 1
  });
  server.players = ['a', 'b', 'c', 'd'].map((id) => rosterPlayer(id, 1));
  const admin = { ...server.players[0], name: 'Admin' };
  await plugin.onChatMessage({ player: admin, chat: 'ChatAdmin', message: '!switch queueshuffle' });
  assert.equal(plugin.queuedShuffle, false);
  assert.match(warnings.at(-1)?.message ?? '', /disabled by configuration/);
  await plugin.autoBalanceTeams();
  await plugin.randomizeSquads({ team1: [], team2: [] });
  assert.equal(await plugin.runSmartShuffle({}, true, 'Manual'), false);
  assert.equal(
    await plugin.maybeShuffleOnRoundEnd({ winner: { team: 1 }, loser: { team: 2 } }),
    false
  );
  assert.deepEqual(switched, []);
  await plugin.switchPlayer('a', 2);
  assert.deepEqual(switched, ['a']);
  await plugin.models.Endmatch.create({ name: 'b', eosID: 'b' });
  await plugin.onRoundEnded({});
  assert.deepEqual(switched, ['a', 'b']);
  assert.equal(await plugin.models.Endmatch.count(), 0);
});

test('SmartSwitch stops a delayed shuffle when the next round starts and still reports it', async (t) => {
  const { plugin, switched } = await auditedContext(t, { shuffleDelaySeconds: 0.02 });
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  plugin.queuedShuffle = true;
  const attempt = plugin.onRoundEnded({});
  await new Promise((resolve) => setTimeout(resolve, 5));
  plugin.onNewGame();
  await attempt;
  assert.deepEqual(switched, []);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.cancelled, true);
});

test('SmartSwitch does not repeat a completed round-end event', async (t) => {
  const { plugin, server, switched } = await auditedContext(t, { consecutiveWinsThreshold: 1 });
  server.players = ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const info = { time: 'round-one', winner: { team: 1 }, loser: { team: 2 } };
  await plugin.onRoundEnded(info);
  const first = [...switched];
  await plugin.onRoundEnded(info);
  plugin.onNewGame();
  await plugin.onRoundEnded(info);
  assert.ok(first.length > 0);
  assert.deepEqual(switched, first);
});

test('SmartSwitch sends detailed post-shuffle embeds and result summary after a partial failure', async (t) => {
  const { plugin, server } = await auditedContext(t);
  server.players = ['a', 'b', 'c', 'd'].map((id, i) =>
    rosterPlayer(id, i < 2 ? 1 : 2, { name: '*Player* @everyone' })
  );
  plugin.calculateSquadScores = async () => {};
  const normal = server.rcon.switchTeam;
  server.rcon.switchTeam = async (id) => {
    if (id === 'c') throw new Error('command failed');
    await normal(id);
  };
  const embeds: {
    title: string;
    description?: string;
    fields: { name: string; value: string }[];
  }[] = [];
  plugin.sendDiscordMessage = async ({ embed }) => {
    embeds.push(embed);
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.ok(embeds.some((embed) => embed.title.includes('Team Balance Summary')));
  assert.ok(embeds.some((embed) => embed.title.includes('Squad Composition')));
  assert.equal(embeds.filter((embed) => embed.title === 'Shuffle results').length, 1);
  assert.match(embeds.at(-1)?.fields[0]?.value ?? '', /command failed/);
  assert.ok(embeds.flatMap((embed) => embed.fields).every((field) => field.value.length <= 1024));
});

test('SmartSwitch captures round generation before roster and database queue preparation', async (t) => {
  for (const scenario of [
    { stage: 'roster', manual: true },
    { stage: 'database', manual: true },
    { stage: 'roster', manual: false },
    { stage: 'database', manual: false }
  ]) {
    const { stage, manual } = scenario;
    const { plugin, server, switched } = await auditedContext(t, { consecutiveWinsThreshold: 1 });
    server.players = ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
    const reports: Record<string, unknown>[] = [];
    plugin.sendReshuffleReport = async () => {};
    plugin.sendShuffleOutcome = async (summary) => {
      reports.push(summary);
    };
    if (stage === 'roster') {
      const original = server.rcon.getListPlayers;
      let first = true;
      server.rcon.getListPlayers = async () => {
        if (first) {
          first = false;
          plugin.onNewGame();
        }
        return original();
      };
    } else {
      plugin.models.Endmatch.findAll = async () => {
        plugin.onNewGame();
        return [];
      };
    }
    plugin.queuedShuffle = manual;
    await plugin.onRoundEnded({ winner: { team: 1 }, loser: { team: 2 } });
    assert.deepEqual(switched, [], stage);
    assert.equal(reports.length, 1, stage);
    assert.equal(reports[0]?.cancelled, true, stage);
  }
});

test('SmartSwitch continues independent groups after a commanded player departs', async (t) => {
  const { plugin, server, switched } = await auditedContext(t);
  server.players = ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  const normal = server.rcon.switchTeam;
  const commands: string[] = [];
  server.rcon.switchTeam = async (id) => {
    commands.push(id);
    if (id === 'a') server.players = server.players.filter((player) => player.eosID !== id);
    else await normal(id);
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.deepEqual(commands, ['a', 'c']);
  assert.deepEqual(switched, ['c']);
  assert.equal(reports[0]?.skipped, 0);
  assert.equal(reports[0]?.departed, 1);
  assert.equal(reports[0]?.failed, 0);
  assert.equal(reports[0]?.moved, 1);
});

test('SmartSwitch cancellation during a command records every planned group once', async (t) => {
  const { plugin, server } = await auditedContext(t);
  server.players = ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  const commands: string[] = [];
  server.rcon.switchTeam = async (id) => {
    commands.push(id);
    plugin.onNewGame();
    server.players = [];
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.deepEqual(commands, ['a']);
  const summary = reports[0]!;
  const groups = summary.groups as { players: string[] }[];
  assert.deepEqual(
    groups.flatMap((group) => group.players),
    ['a', 'c']
  );
  assert.equal(summary.cancelled, true);
  assert.equal(
    summary.planned,
    Number(summary.moved) + Number(summary.skipped) + Number(summary.failed)
  );
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
});

test('SmartSwitch moves ordinary squad survivors and counts departures separately', async (t) => {
  for (const timing of ['preflight', 'command']) {
    const { plugin, server, switched } = await auditedContext(t);
    server.players = ['a', 'b', 'c', 'g', 'h', 'i', 'd', 'e', 'f', 'j', 'k', 'l'].map((id, i) =>
      rosterPlayer(id, i < 6 ? 1 : 2, { squadID: i % 6 < 3 ? 1 : 2 })
    );
    plugin.calculateSquadScores = async () => {
      if (timing === 'preflight')
        server.players = server.players.filter((player) => player.eosID !== 'a');
    };
    const normal = server.rcon.switchTeam;
    server.rcon.switchTeam = async (id) => {
      if (id === 'a') server.players = server.players.filter((player) => player.eosID !== id);
      else await normal(id);
    };
    plugin.sendReshuffleReport = async () => {};
    const reports: Record<string, unknown>[] = [];
    plugin.sendShuffleOutcome = async (summary) => {
      reports.push(summary);
    };
    await plugin.runSmartShuffle({}, true, 'Manual');
    assert.ok(switched.includes('b') && switched.includes('c'), timing);
    const summary = reports[0]!;
    assert.equal(summary.departed, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.planned, Number(summary.moved) + Number(summary.departed));
  }
});

test('SmartSwitch separates departed party leader from unsafe survivors and accepts fresh transfer', async (t) => {
  for (const transfer of [false, true]) {
    const { plugin, server, switched } = await auditedContext(t);
    server.players = [
      rosterPlayer('a', 1, { partyID: 0, isLeader: true }),
      rosterPlayer('b', 1, { partyID: 0 }),
      rosterPlayer('c', 1, { partyID: 0 }),
      ...['d', 'e', 'f'].map((id) => rosterPlayer(id, 2, { squadID: 1 }))
    ];
    plugin.calculateSquadScores = async () => {
      server.players = server.players.filter((player) => player.eosID !== 'a');
      if (transfer) server.players.find((player) => player.eosID === 'b')!.isLeader = true;
    };
    const normal = server.rcon.switchTeam;
    server.rcon.switchTeam = async (id) => {
      if (id === 'b') {
        switched.push(id);
        server.players
          .filter((player) => player.partyID === 0)
          .forEach((player) => (player.teamID = 2));
      } else await normal(id);
    };
    plugin.sendReshuffleReport = async () => {};
    const reports: Record<string, unknown>[] = [];
    plugin.sendShuffleOutcome = async (summary) => {
      reports.push(summary);
    };
    await plugin.runSmartShuffle({}, true, 'Manual');
    assert.equal(switched.includes('b'), transfer);
    const summary = reports[0]!;
    assert.equal(summary.departed, 1);
    assert.equal(summary.skipped, transfer ? 0 : 2);
    assert.equal(
      summary.planned,
      Number(summary.moved) +
        Number(summary.departed) +
        Number(summary.skipped) +
        Number(summary.failed)
    );
  }
});

test('SmartSwitch new-round cancellation stops ordinary survivors after a departure command', async (t) => {
  const { plugin, server } = await auditedContext(t);
  server.players = ['a', 'b', 'c', 'g', 'h', 'i', 'd', 'e', 'f', 'j', 'k', 'l'].map((id, i) =>
    rosterPlayer(id, i < 6 ? 1 : 2, { squadID: i % 6 < 3 ? 1 : 2 })
  );
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  const commands: string[] = [];
  server.rcon.switchTeam = async (id) => {
    commands.push(id);
    server.players = server.players.filter((player) => player.eosID !== id);
    plugin.onNewGame();
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.deepEqual(commands, ['a']);
  const summary = reports[0]!;
  assert.equal(summary.cancelled, true);
  assert.equal(summary.departed, 1);
  assert.equal(summary.moved, 0);
  assert.equal(summary.skipped, 5);
  assert.equal(summary.planned, Number(summary.departed) + Number(summary.skipped));
});

test('SmartSwitch realistic shuffles move near half and finish balanced under churn and party constraints', async (t) => {
  for (const scenario of ['ordinary', 'churn', 'cross-squad-party', 'large-party']) {
    const { plugin, server } = await auditedContext(t);
    let live: Record<string, unknown>[] = [];
    for (const teamID of [1, 2]) {
      const size = scenario === 'ordinary' || scenario === 'churn' ? 20 : 24;
      const partySize = scenario === 'large-party' ? 16 : scenario === 'cross-squad-party' ? 6 : 0;
      for (let i = 0; i < size; i++) {
        const inParty = i < partySize;
        live.push(
          rosterPlayer(`t${teamID}-${i}`, teamID, {
            partyID: inParty ? teamID : null,
            squadID: inParty
              ? (i % 2) + 1
              : i < (partySize ? partySize + 8 : 7)
                ? 3
                : i < 14
                  ? 4
                  : i < 18
                    ? 5
                    : null,
            isLeader: inParty && i === 0
          })
        );
      }
    }
    server.players = structuredClone(live); // Deliberately keep the periodic cache stale.
    server.rcon.getListPlayers = async () => structuredClone(live);
    plugin.calculateSquadScores = async (groups) => {
      groups.forEach((group) => {
        group.performanceScore = group.partyID != null ? 100 : 0;
      });
    };
    plugin.sendReshuffleReport = async () => {};
    const reports: Record<string, unknown>[] = [];
    plugin.sendShuffleOutcome = async (summary) => {
      reports.push(summary);
    };
    let commands = 0;
    let peak = 0;
    const capacity =
      scenario === 'ordinary'
        ? 21
        : scenario === 'churn'
          ? 26
          : scenario === 'large-party'
            ? 40
            : 30;
    server.rcon.switchTeam = async (id) => {
      commands++;
      const player = live.find((candidate) => candidate.eosID === id)!;
      const destination = player.teamID === 1 ? 2 : 1;
      const members =
        player.partyID == null
          ? [player]
          : live.filter(
              (member) => member.teamID === player.teamID && member.partyID === player.partyID
            );
      const destinationSize = live.filter((member) => member.teamID === destination).length;
      if (destinationSize + members.length > capacity) throw new Error('Team capacity reached');
      members.forEach((member) => {
        member.teamID = destination;
      });
      if (scenario === 'churn' && commands === 5) {
        live = live.filter((member) => !['t1-6', 't2-19'].includes(String(member.eosID)));
        live.push(
          ...['join-1', 'join-2', 'join-3', 'join-4', 'join-5'].map((eosID) =>
            rosterPlayer(eosID, 2)
          )
        );
      }
      peak = Math.max(
        peak,
        ...[1, 2].map((teamID) => live.filter((member) => member.teamID === teamID).length)
      );
    };
    await plugin.runSmartShuffle({}, true, 'Manual');
    const summary = reports[0]!;
    const teams = summary.teams as Record<
      string,
      { initial: number; moved: number; movedFraction: number; final: number }
    >;
    assert.equal(summary.failed, 0, scenario);
    assert.ok(Number(summary.finalGap) <= 1, scenario);
    assert.ok(peak <= capacity, scenario);
    for (const team of Object.values(teams)) {
      if (scenario === 'large-party') assert.equal(team.movedFraction, 0.667, scenario);
      else
        assert.ok(
          team.movedFraction >= 0.35 && team.movedFraction <= 0.65,
          `${scenario}: ${JSON.stringify(team)}`
        );
    }
    for (const partyID of [1, 2]) {
      const members = live.filter((member) => member.partyID === partyID);
      if (members.length)
        assert.equal(new Set(members.map((member) => member.teamID)).size, 1, scenario);
    }
    if (scenario === 'churn') {
      assert.equal(summary.departedSincePlan, 2);
      assert.equal(summary.joinedSincePlan, 5);
      const groups = summary.groups as { phase: string; moved: number; players: string[] }[];
      assert.ok(groups.some((group) => group.phase === 'balance' && group.moved > 0));
    }
    assert.equal(
      summary.planned,
      Number(summary.moved) +
        Number(summary.departed) +
        Number(summary.skipped) +
        Number(summary.failed),
      scenario
    );
  }
});

test('SmartSwitch capacity refusal is reported without retrying or claiming movement', async (t) => {
  const { plugin, server } = await auditedContext(t);
  server.players = Array.from({ length: 40 }, (_, i) => rosterPlayer(`p${i}`, i < 20 ? 1 : 2));
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  let commands = 0;
  server.rcon.switchTeam = async () => {
    commands++;
    throw new Error('Team capacity reached');
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.equal(commands, 1);
  assert.equal(reports[0]?.moved, 0);
  assert.match(String(reports[0]?.error), /capacity/);
  assert.equal(reports[0]?.finalGap, 0);
});

test('SmartSwitch reports unexpectedly moved pending targets as observed moves without sending their command', async (t) => {
  const { plugin, server } = await auditedContext(t);
  server.players = ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
  plugin.calculateSquadScores = async () => {};
  plugin.sendReshuffleReport = async () => {};
  const reports: Record<string, unknown>[] = [];
  plugin.sendShuffleOutcome = async (summary) => {
    reports.push(summary);
  };
  const commands: string[] = [];
  server.rcon.switchTeam = async (id) => {
    commands.push(id);
    server.players.find((player) => player.eosID === 'a')!.teamID = 2;
    server.players.find((player) => player.eosID === 'c')!.teamID = 1;
  };
  await plugin.runSmartShuffle({}, true, 'Manual');
  assert.deepEqual(commands, ['a']);
  const summary = reports[0]!;
  assert.equal(summary.planned, 2);
  assert.equal(summary.moved, 2);
  assert.equal(summary.skipped, 0);
  assert.match(String(summary.error), /outside the plan/);
  const groups = summary.groups as { players: string[]; moved: number; reason?: string }[];
  const pending = groups.find((group) => group.players.includes('c'))!;
  assert.equal(pending.moved, 1);
  assert.match(pending.reason ?? '', /Unexpectedly moved/);
});

test('SmartSwitch final roster classifies pending departure after capacity refusal exactly once', async (t) => {
  for (const finalAvailable of [true, false]) {
    const { plugin, server } = await auditedContext(t);
    server.players = ['a', 'b', 'c', 'd'].map((id, i) => rosterPlayer(id, i < 2 ? 1 : 2));
    plugin.calculateSquadScores = async () => {};
    plugin.sendReshuffleReport = async () => {};
    const reports: Record<string, unknown>[] = [];
    plugin.sendShuffleOutcome = async (summary) => {
      reports.push(summary);
    };
    const normal = server.rcon.getListPlayers;
    let postFailureReads = 0;
    let commandSent = false;
    server.rcon.getListPlayers = async () => {
      if (commandSent && ++postFailureReads > 1 && !finalAvailable)
        throw new Error('Final roster unavailable');
      return normal();
    };
    const commands: string[] = [];
    server.rcon.switchTeam = async (id) => {
      commands.push(id);
      commandSent = true;
      server.players = server.players.filter((player) => player.eosID !== 'c');
      throw new Error('Team capacity reached');
    };
    await plugin.runSmartShuffle({}, true, 'Manual');
    assert.deepEqual(commands, ['a']);
    const summary = reports[0]!;
    assert.equal(summary.planned, 2);
    assert.equal(summary.moved, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.departed, finalAvailable ? 1 : 0);
    assert.equal(summary.skipped, finalAvailable ? 0 : 1);
    assert.equal(
      summary.planned,
      Number(summary.moved) +
        Number(summary.failed) +
        Number(summary.departed) +
        Number(summary.skipped)
    );
    assert.match(String(summary.error), /capacity/);
    if (finalAvailable) {
      assert.equal(summary.departedSincePlan, 1);
      const groups = summary.groups as { players: string[]; departed: string[]; outcome: string }[];
      const pending = groups.find((group) => group.players.includes('c'))!;
      assert.deepEqual(pending.departed, ['c']);
      assert.equal(pending.outcome, 'departed');
    } else {
      assert.match(String(summary.metricsError), /Final roster unavailable/);
      assert.equal(summary.departedSincePlan, undefined);
    }
  }
});

test('SmartSwitch optimized successful cycles use two per-move RCON calls plus fixed overhead', async (t) => {
  for (const population of [25, 50, 100]) {
    const { plugin, server } = await auditedContext(t);
    server.players = Array.from({ length: population }, (_, i) =>
      rosterPlayer(`p${i}`, i < Math.floor(population / 2) ? 1 : 2)
    );
    plugin.calculateSquadScores = async () => {};
    plugin.sendDiscordMessage = async () => {};
    let version = 0;
    const counts = { listPlayers: 0, listSquads: 0, switchTeam: 0 };
    server.rcon.getMutationVersion = () => version;
    const listPlayers = server.rcon.getListPlayers;
    const listSquads = server.rcon.getSquads;
    const switchTeam = server.rcon.switchTeam;
    server.rcon.getListPlayers = async () => {
      counts.listPlayers++;
      return listPlayers();
    };
    server.rcon.getSquads = async () => {
      counts.listSquads++;
      return listSquads();
    };
    server.rcon.switchTeam = async (id) => {
      counts.switchTeam++;
      version++;
      await switchTeam(id);
    };
    plugin.queuedShuffle = true;
    await plugin.onRoundEnded({ time: `population-${population}` });
    const moved = 2 * Math.floor(Math.floor(population / 2) / 2);
    assert.equal(counts.switchTeam, moved);
    assert.equal(counts.listPlayers, moved + 7);
    assert.equal(counts.listSquads, 1);
    assert.equal(counts.listPlayers + counts.listSquads + counts.switchTeam, 2 * moved + 8);
  }
});
