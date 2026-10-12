import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

type Player = {
  eosID: string;
  teamID: number;
  partyID?: number | null;
  isLeader?: boolean;
  squadID?: number;
};
type Server = {
  players: Player[];
  rcon: {
    getListPlayers(): Promise<Player[]>;
    switchTeam(id: string): Promise<void>;
    getMutationVersion?(): number | null;
  };
};
const helper = (await import(pathToFileURL(resolve('squad-server/utils/team-switch.js')).href)) as {
  switchGroups(players: Player[], bySquad?: boolean): { players: Player[] }[];
  readSwitchRoster(
    server: Server,
    previous?: Player[],
    current?: Player[],
    operation?: object
  ): Promise<Player[]>;
  moveToTeam(
    server: Server,
    players: Player[],
    teamID: number,
    options?: {
      wholeParties?: boolean;
      initialRoster?: Player[];
      operation?: object;
      onDeparted?: (player: Player) => void;
    }
  ): Promise<{ players: Player[]; moved: Set<string>; departed: Set<string> }>;
};
function server(players: Player[], command: (id: string) => void): Server {
  return {
    players,
    rcon: {
      getListPlayers: async () => players.map((p) => ({ ...p })),
      switchTeam: async (id) => command(id)
    }
  };
}
test('switch grouping keeps party zero together across squads and scopes IDs by team', () => {
  const players = [
    { eosID: 'a', teamID: 1, partyID: 0, squadID: 1 },
    { eosID: 'b', teamID: 1, partyID: 0, squadID: 2 },
    { eosID: 'c', teamID: 2, partyID: 0, squadID: 1 },
    { eosID: 'd', teamID: 1, partyID: null },
    { eosID: 'e', teamID: 1, partyID: null }
  ];
  assert.deepEqual(
    helper.switchGroups(players).map((g) => g.players.map((p) => p.eosID)),
    [['a', 'b'], ['c'], ['d'], ['e']]
  );
});
test('a server party move is verified once and its second member is not toggled', async () => {
  const players = [
    { eosID: 'a', teamID: 1, partyID: 0, isLeader: true },
    { eosID: 'b', teamID: 1, partyID: 0 }
  ];
  const calls: string[] = [];
  const result = await helper.moveToTeam(
    server(players, (id) => {
      calls.push(id);
      players.forEach((p) => (p.teamID = 2));
    }),
    players.map((p) => ({ ...p })),
    2
  );
  assert.deepEqual(calls, ['a']);
  assert.equal(result.moved.size, 2);
});
test('an unconfirmed acknowledgement stops without retrying', async () => {
  const players = [{ eosID: 'a', teamID: 1 }];
  let calls = 0;
  await assert.rejects(
    helper.moveToTeam(
      server(players, () => {
        calls++;
      }),
      players,
      2
    ),
    /not confirmed/
  );
  assert.equal(calls, 1);
});
test('a lost acknowledgement succeeds only when the destination is observed', async () => {
  const players = [{ eosID: 'a', teamID: 1 }];
  const result = await helper.moveToTeam(
    server(players, () => {
      players[0]!.teamID = 2;
      throw new Error('lost acknowledgement');
    }),
    players,
    2
  );
  assert.equal(result.moved.size, 1);
});
test('empty, duplicate and missing-target rosters fail before a command', async () => {
  for (const current of [
    [],
    [
      { eosID: 'a', teamID: 1 },
      { eosID: 'a', teamID: 1 }
    ],
    [{ eosID: 'b', teamID: 1 }]
  ]) {
    let calls = 0;
    const value = server(current, () => {
      calls++;
    });
    value.players = [{ eosID: 'a', teamID: 1 }];
    await assert.rejects(helper.moveToTeam(value, value.players, 2));
    assert.equal(calls, 0);
  }
});
test('unexpected server movement stops remaining commands', async () => {
  const players = [
    { eosID: 'a', teamID: 1 },
    { eosID: 'b', teamID: 1 },
    { eosID: 'outside', teamID: 1 }
  ];
  let calls = 0;
  await assert.rejects(
    helper.moveToTeam(
      server(players, () => {
        calls++;
        players[0]!.teamID = 2;
        players[2]!.teamID = 2;
      }),
      players.slice(0, 2),
      2
    ),
    /outside the plan/
  );
  assert.equal(calls, 1);
});

const file = 'team-randomizer';
{
  test(`${file} preserves parties when the server moves leader and members together`, async () => {
    const { default: Plugin } = (await import(
      pathToFileURL(resolve(`squad-server/plugins/${file}.js`)).href
    )) as {
      default: {
        prototype: {
          onChatCommand: (this: unknown, info: unknown) => Promise<void>;
        };
      };
    };
    const players = [
      { eosID: 'member', teamID: 1, partyID: 0, isLeader: false },
      { eosID: 'leader', teamID: 1, partyID: 0, isLeader: true },
      { eosID: 'other-member', teamID: 2, partyID: 1, isLeader: false },
      { eosID: 'other-leader', teamID: 2, partyID: 1, isLeader: true }
    ];
    const calls: string[] = [];
    const value = server(players, (id) => {
      calls.push(id);
      const player = players.find((p) => p.eosID === id)!;
      const destination = player.teamID === 1 ? 2 : 1;
      for (const member of players.filter((p) => p.partyID === player.partyID))
        member.teamID = destination;
    });
    const context = { server: value, options: { showBroadcasts: false } };
    await Plugin.prototype.onChatCommand.call(context, { chat: 'ChatAdmin' });
    assert.ok(calls.every((id) => id.endsWith('leader')));
    assert.equal(new Set(calls).size, calls.length);
    assert.equal(players[0]!.teamID, players[1]!.teamID);
    assert.equal(players[2]!.teamID, players[3]!.teamID);
  });
}

test('whole-party moves use current leader flags rather than stale plan flags', async () => {
  const players = [
    { eosID: 'a', teamID: 1, partyID: 0, isLeader: false },
    { eosID: 'b', teamID: 1, partyID: 0, isLeader: true }
  ];
  const planned = players.map((p) => ({ ...p, isLeader: p.eosID === 'a' }));
  const calls: string[] = [];
  await helper.moveToTeam(
    server(players, (id) => {
      calls.push(id);
      players.forEach((p) => (p.teamID = 2));
    }),
    planned,
    2,
    { wholeParties: true }
  );
  assert.deepEqual(calls, ['b']);
});

test('whole-party preflight skips changed membership before any command', async () => {
  for (const extra of [
    { eosID: 'new', teamID: 1, partyID: 0 },
    { eosID: 'a', teamID: 1, partyID: 1 }
  ]) {
    const planned = [{ eosID: 'a', teamID: 1, partyID: 0, isLeader: true }];
    const players = extra.eosID === 'a' ? [extra] : [...planned, extra];
    let calls = 0;
    await assert.rejects(
      helper.moveToTeam(
        server(players, () => {
          calls++;
        }),
        planned,
        2,
        { wholeParties: true }
      ),
      /outside the plan|membership/
    );
    assert.equal(calls, 0);
  }
});

test('departure with movement outside the group still stops the shuffle', async () => {
  const players = [
    { eosID: 'departing', teamID: 1 },
    { eosID: 'remaining', teamID: 1 },
    { eosID: 'outside', teamID: 1 }
  ];
  const planned = players.slice(0, 2).map((player) => ({ ...player }));
  let calls = 0;
  const value = server(players, () => {
    calls++;
    players.splice(0, 1);
    players.find((player) => player.eosID === 'outside')!.teamID = 2;
  });
  await assert.rejects(
    helper.moveToTeam(value, planned, 2, { wholeParties: true }),
    /outside the plan/
  );
  assert.equal(calls, 1);
});

test('ordinary squad departures remove only the missing target before or during execution', async () => {
  for (const timing of ['preflight', 'command']) {
    const players = ['a', 'b', 'c', 'outside'].map((eosID) => ({ eosID, teamID: 1, squadID: 1 }));
    const planned = players.slice(0, 3).map((player) => ({ ...player }));
    if (timing === 'preflight') players.splice(0, 1);
    const calls: string[] = [];
    const result = await helper.moveToTeam(
      server(players, (id) => {
        calls.push(id);
        if (id === 'a')
          players.splice(
            players.findIndex((player) => player.eosID === id),
            1
          );
        else players.find((player) => player.eosID === id)!.teamID = 2;
      }),
      planned,
      2,
      { wholeParties: true }
    );
    assert.deepEqual(calls, timing === 'preflight' ? ['b', 'c'] : ['a', 'b', 'c']);
    assert.deepEqual([...result.moved], ['b', 'c']);
    assert.deepEqual([...result.departed], ['a']);
  }
});

test('party survivors use fresh member and leader identity after departures', async () => {
  for (const scenario of [
    'member-preflight',
    'member-command',
    'leader-preflight',
    'leader-command'
  ]) {
    const players = [
      { eosID: 'a', teamID: 1, partyID: 0, isLeader: true },
      { eosID: 'b', teamID: 1, partyID: 0, isLeader: false },
      { eosID: 'c', teamID: 1, partyID: 0, isLeader: false },
      { eosID: 'outside', teamID: 2, partyID: null, isLeader: false }
    ];
    const planned = players.slice(0, 3).map((player) => ({ ...player }));
    const departedID = scenario.startsWith('member') ? 'b' : 'a';
    const remove = () => {
      players.splice(
        players.findIndex((player) => player.eosID === departedID),
        1
      );
      if (departedID === 'a') players.find((player) => player.eosID === 'b')!.isLeader = true;
    };
    if (scenario.endsWith('preflight')) remove();
    const calls: string[] = [];
    const result = await helper.moveToTeam(
      server(players, (id) => {
        calls.push(id);
        if (scenario.endsWith('command') && calls.length === 1) {
          remove();
          if (departedID === 'a') return;
        }
        players.filter((player) => player.partyID === 0).forEach((player) => (player.teamID = 2));
      }),
      planned,
      2,
      { wholeParties: true }
    );
    assert.deepEqual([...result.departed], [departedID], scenario);
    assert.equal(result.moved.size, 2, scenario);
    assert.deepEqual(
      calls,
      scenario === 'leader-command' ? ['a', 'b'] : scenario === 'leader-preflight' ? ['b'] : ['a'],
      scenario
    );
  }
});

test('party leader departure without verified replacement refuses the survivors', async () => {
  const planned = [
    { eosID: 'a', teamID: 1, partyID: 0, isLeader: true },
    { eosID: 'b', teamID: 1, partyID: 0, isLeader: false },
    { eosID: 'c', teamID: 1, partyID: 0, isLeader: false }
  ];
  const departures: string[] = [];
  let calls = 0;
  await assert.rejects(
    helper.moveToTeam(
      server(planned.slice(1), () => {
        calls++;
      }),
      planned,
      2,
      {
        wholeParties: true,
        onDeparted: (player) => {
          departures.push(player.eosID);
        }
      }
    ),
    /missing or ambiguous/
  );
  assert.equal(calls, 0);
  assert.deepEqual(departures, ['a']);
});

test('a confirmed player returning to its source is stopped without a second command', async () => {
  const players = ['a', 'b', 'c'].map((eosID) => ({ eosID, teamID: 1 }));
  const calls: string[] = [];
  await assert.rejects(
    helper.moveToTeam(
      server(players, (id) => {
        calls.push(id);
        players.find((player) => player.eosID === id)!.teamID = 2;
        if (id === 'b') players.find((player) => player.eosID === 'a')!.teamID = 1;
      }),
      players.map((player) => ({ ...player })),
      2,
      { wholeParties: true }
    ),
    /destination changed again/
  );
  assert.deepEqual(calls, ['a', 'b']);
});

test('verified post-move rosters are reused only by their owning operation', async () => {
  const players = ['a', 'b'].map((eosID) => ({ eosID, teamID: 1 }));
  const operation = {};
  let version = 0;
  let reads = 0;
  const value = server(players, (id) => {
    version++;
    players.find((player) => player.eosID === id)!.teamID = 2;
  });
  value.rcon.getMutationVersion = () => version;
  value.rcon.getListPlayers = async () => {
    reads++;
    return players.map((player) => ({ ...player }));
  };
  let current = await helper.readSwitchRoster(value, [], undefined, operation);
  current = (
    await helper.moveToTeam(value, [players[0]!], 2, {
      wholeParties: true,
      initialRoster: current,
      operation
    })
  ).players;
  await helper.moveToTeam(value, [players[1]!], 2, {
    wholeParties: true,
    initialRoster: current,
    operation
  });
  assert.equal(reads, 3);
});

test('mutating requests, connection loss, reconnects and another operation force a fresh baseline', async () => {
  for (const scenario of ['mutation', 'disconnected', 'reconnect', 'other-operation']) {
    const players = [
      { eosID: 'a', teamID: 1, partyID: 0, isLeader: true },
      { eosID: 'b', teamID: 1, partyID: 0, isLeader: false }
    ];
    const operation = {};
    let version = 0;
    let disconnected = false;
    let reads = 0;
    const commands: string[] = [];
    const value = server(players, (id) => {
      version++;
      commands.push(id);
      players.forEach((player) => (player.teamID = 2));
    });
    value.rcon.getMutationVersion = () => (disconnected ? null : version);
    value.rcon.getListPlayers = async () => {
      reads++;
      disconnected = false;
      return players.map((player) => ({ ...player }));
    };
    const current = await helper.readSwitchRoster(value, [], undefined, operation);
    players[0]!.isLeader = false;
    players[1]!.isLeader = true;
    if (scenario === 'mutation' || scenario === 'reconnect') version++;
    else if (scenario === 'disconnected') disconnected = true;
    await helper.moveToTeam(
      value,
      players.map((player) => ({ ...player })),
      2,
      {
        wholeParties: true,
        initialRoster: current,
        operation: scenario === 'other-operation' ? {} : operation
      }
    );
    assert.equal(reads, 3, scenario);
    assert.deepEqual(commands, ['b'], scenario);
  }
});

test('a mutation issued between reuse and dispatch forces a fresh leader check', async () => {
  const players = [
    { eosID: 'a', teamID: 1, partyID: 0, isLeader: true },
    { eosID: 'b', teamID: 1, partyID: 0, isLeader: false }
  ];
  const operation = {};
  let version = 0;
  let reads = 0;
  const commands: string[] = [];
  const value = server(players, (id) => {
    version++;
    commands.push(id);
    players.forEach((player) => (player.teamID = 2));
  });
  value.rcon.getMutationVersion = () => version;
  value.rcon.getListPlayers = async () => {
    reads++;
    return players.map((player) => ({ ...player }));
  };
  const current = await helper.readSwitchRoster(value, [], undefined, operation);
  const pending = helper.moveToTeam(
    value,
    players.map((player) => ({ ...player })),
    2,
    { wholeParties: true, initialRoster: current, operation }
  );
  version++;
  players[0]!.isLeader = false;
  players[1]!.isLeader = true;
  await pending;
  assert.deepEqual(commands, ['b']);
  assert.equal(reads, 3);
});

test('read-only polling does not invalidate an operation handoff', async () => {
  const players = ['a', 'b'].map((eosID) => ({ eosID, teamID: 1 }));
  const operation = {};
  let version = 0;
  let reads = 0;
  const value = server(players, (id) => {
    version++;
    players.find((player) => player.eosID === id)!.teamID = 2;
  });
  value.rcon.getMutationVersion = () => version;
  value.rcon.getListPlayers = async () => {
    reads++;
    return players.map((player) => ({ ...player }));
  };
  const current = await helper.readSwitchRoster(value, [], undefined, operation);
  await value.rcon.getListPlayers(); // An intervening read leaves the mutation version unchanged.
  await helper.moveToTeam(value, [players[0]!], 2, {
    wholeParties: true,
    initialRoster: current,
    operation
  });
  assert.equal(reads, 3); // Initial read, background read, post-move verification.
});

test('a mutation during a roster query invalidates that query before dispatch', async () => {
  const players = [
    { eosID: 'a', teamID: 1, partyID: 0, isLeader: true },
    { eosID: 'b', teamID: 1, partyID: 0, isLeader: false }
  ];
  const operation = {};
  let version = 0;
  let reads = 0;
  const commands: string[] = [];
  const value = server(players, (id) => {
    version++;
    commands.push(id);
    players.forEach((player) => (player.teamID = 2));
  });
  value.rcon.getMutationVersion = () => version;
  value.rcon.getListPlayers = async () => {
    reads++;
    const response = players.map((player) => ({ ...player }));
    if (reads === 1) {
      version++;
      players[0]!.isLeader = false;
      players[1]!.isLeader = true;
    }
    return response;
  };
  const current = await helper.readSwitchRoster(value, [], undefined, operation);
  await helper.moveToTeam(
    value,
    players.map((player) => ({ ...player })),
    2,
    { wholeParties: true, initialRoster: current, operation }
  );
  assert.deepEqual(commands, ['b']);
  assert.equal(reads, 3);
});

test('an unrelated departure from the periodic cache does not block a present requested player', async () => {
  const players = [{ eosID: 'present', teamID: 1 }];
  const calls: string[] = [];
  const value = server(players, (id) => {
    calls.push(id);
    players[0]!.teamID = 2;
  });
  value.players = [...players, { eosID: 'departed', teamID: 1 }];
  const result = await helper.moveToTeam(value, [players[0]!], 2);
  assert.deepEqual(calls, ['present']);
  assert.deepEqual([...result.moved], ['present']);
});
