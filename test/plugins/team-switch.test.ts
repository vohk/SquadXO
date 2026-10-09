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
  rcon: { getListPlayers(): Promise<Player[]>; switchTeam(id: string): Promise<void> };
};
const helper = (await import(pathToFileURL(resolve('squad-server/utils/team-switch.js')).href)) as {
  switchGroups(players: Player[], bySquad?: boolean): { players: Player[] }[];
  readSwitchRoster(server: Server): Promise<Player[]>;
  moveToTeam(server: Server, players: Player[], teamID: number): Promise<{ moved: Set<string> }>;
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
test('empty, duplicate and incomplete rosters fail before a command', async () => {
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
