// Shared by the legacy switchers: plan destinations, then verify each command once.
export async function readSwitchRoster(server, previous = server.players ?? []) {
  const players = await server.rcon.getListPlayers();
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('Player roster is empty; team changes were not attempted');
  }
  const ids = new Set();
  for (const player of players) {
    if (
      !player.eosID ||
      ids.has(player.eosID) ||
      (player.teamID != null && player.teamID !== 1 && player.teamID !== 2)
    ) {
      throw new Error('Player roster is invalid; team changes were not attempted');
    }
    ids.add(player.eosID);
  }
  if (previous.some((player) => player.eosID && !ids.has(player.eosID))) {
    throw new Error('Player roster changed or is incomplete; retry after a fresh roster');
  }
  return players.map((player) => ({ ...player }));
}

export function switchGroups(players, bySquad = true) {
  const groups = new Map();
  for (const player of players) {
    if (player.teamID !== 1 && player.teamID !== 2) continue;
    const key =
      player.partyID != null
        ? `party-${player.teamID}-${player.partyID}`
        : bySquad && player.squadID != null
          ? `squad-${player.teamID}-${player.squadID}`
          : `unassigned-${player.eosID}`;
    if (!groups.has(key))
      groups.set(key, {
        squadID: player.partyID != null ? key : (player.squadID ?? key),
        teamID: player.teamID,
        partyID: player.partyID,
        players: []
      });
    groups.get(key).players.push(player);
  }
  return [...groups.values()];
}

export async function moveToTeam(
  server,
  targets,
  teamID,
  { isActive = () => true, onMoved = () => {}, roster } = {}
) {
  if ((teamID !== 1 && teamID !== 2) || targets.length === 0) {
    throw new Error('Team change requires players and a destination team');
  }
  const ordered = [...targets].sort(
    (a, b) => Number(Boolean(b.isLeader)) - Number(Boolean(a.isLeader))
  );
  for (const group of switchGroups(targets, false)) {
    if (
      group.partyID != null &&
      group.players.length > 1 &&
      group.players.filter((p) => p.isLeader).length !== 1
    ) {
      throw new Error('Party leader is missing or ambiguous; team change stopped');
    }
  }
  const targetIDs = new Set(ordered.map((player) => player.eosID));
  const moved = new Set();
  let players = await readSwitchRoster(server, roster);
  for (const eosID of targetIDs) {
    if (!isActive()) throw new Error('Team change stopped because the plugin is inactive');
    const player = players.find((candidate) => candidate.eosID === eosID);
    if (!player || (player.teamID !== 1 && player.teamID !== 2)) {
      throw new Error('A planned player is unavailable; team change stopped');
    }
    if (player.teamID === teamID) continue;
    const before = players;
    let commandError;
    try {
      await server.rcon.switchTeam(eosID);
    } catch (error) {
      commandError = error;
    }
    players = await readSwitchRoster(server, before);
    const changed = players.filter((candidate) => {
      const old = before.find((previous) => previous.eosID === candidate.eosID);
      return old && old.teamID !== candidate.teamID;
    });
    for (const changedPlayer of changed) {
      moved.add(changedPlayer.eosID);
      onMoved(changedPlayer);
    }
    if (changed.some((candidate) => !targetIDs.has(candidate.eosID))) {
      throw new Error('The server moved players outside the plan; further team changes stopped');
    }
    if (players.find((candidate) => candidate.eosID === eosID)?.teamID !== teamID) {
      throw commandError ?? new Error('The requested team change was not confirmed; no retry sent');
    }
    if (!isActive()) throw new Error('Team change stopped because the plugin is inactive');
  }
  return { players, moved };
}
