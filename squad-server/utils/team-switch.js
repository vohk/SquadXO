// Shared by the legacy switchers: plan destinations, then verify each command once.
const snapshots = new WeakMap();
const snapshotMaxAgeMs = 100;
const rosterShape = (players) =>
  JSON.stringify(
    players.map((player) => [
      player.eosID,
      player.teamID,
      player.partyID,
      player.squadID,
      player.isLeader
    ])
  );
export async function readSwitchRoster(server, previous = server.players ?? [], current) {
  const snapshot = current && snapshots.get(current);
  const before = server.rcon.getCommandVersion?.();
  const reusable =
    snapshot?.server === server &&
    snapshot.version === before &&
    snapshot.shape === rosterShape(current) &&
    performance.now() - snapshot.observedAt <= snapshotMaxAgeMs;
  const players = reusable ? current : await server.rcon.getListPlayers();
  const observedAt = reusable ? snapshot.observedAt : performance.now();
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
  const result = players.map((player) => ({ ...player }));
  const after = server.rcon.getCommandVersion?.();
  if (Number.isInteger(before) && after === before + (reusable ? 0 : 1))
    snapshots.set(result, { server, version: after, shape: rosterShape(result), observedAt });
  return result;
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
  {
    isActive = () => true,
    onMoved = () => {},
    onDeparted = () => {},
    roster,
    initialRoster,
    wholeParties = false
  } = {}
) {
  if ((teamID !== 1 && teamID !== 2) || targets.length === 0) {
    throw new Error('Team change requires players and a destination team');
  }
  const targetIDs = new Set(targets.map((player) => player.eosID));
  const moved = new Set();
  const commanded = new Set();
  const departed = new Set();
  const recordDeparture = (target) => {
    if (departed.has(target.eosID)) return;
    departed.add(target.eosID);
    onDeparted(target);
  };
  let players;
  try {
    players = await readSwitchRoster(server, wholeParties ? [] : roster, initialRoster);
  } catch (error) {
    error.stopShuffle = true;
    throw error;
  }
  let first = true;
  while (true) {
    if (!isActive()) throw new Error('Team change stopped because the plugin is inactive');
    const currentTargets = [];
    for (const target of targets) {
      if (wholeParties && departed.has(target.eosID)) continue;
      const player = players.find((candidate) => candidate.eosID === target.eosID);
      if (!player && wholeParties) {
        recordDeparture(target);
        continue;
      }
      if (!player || (player.teamID !== 1 && player.teamID !== 2)) {
        throw new Error('A planned player is unavailable; team change stopped');
      }
      currentTargets.push(player);
    }
    if (currentTargets.some((player) => moved.has(player.eosID) && player.teamID !== teamID)) {
      throw Object.assign(
        new Error('A confirmed destination changed again; further team changes stopped'),
        { stopShuffle: true }
      );
    }
    const currentIDs = new Set(currentTargets.map((player) => player.eosID));
    const pending = currentTargets.filter((player) => player.teamID !== teamID);
    if (pending.length === 0) return { players, moved, departed };
    for (const player of pending) {
      const target = targets.find((candidate) => candidate.eosID === player.eosID);
      if (wholeParties && (player.partyID !== target.partyID || player.teamID !== target.teamID)) {
        throw new Error('Planned party membership or team changed; group skipped');
      }
    }
    if (wholeParties || first) {
      for (const group of switchGroups(currentTargets, false)) {
        if (wholeParties && group.partyID != null) {
          if (
            players.some(
              (player) =>
                player.teamID === group.teamID &&
                player.partyID === group.partyID &&
                !currentIDs.has(player.eosID)
            )
          ) {
            throw new Error('Current party contains a player outside the plan; group skipped');
          }
          const plannedParty = targets.filter(
            (player) => player.teamID === group.teamID && player.partyID === group.partyID
          );
          if (
            plannedParty.some((target) =>
              currentTargets.some(
                (player) => player.eosID === target.eosID && player.teamID !== group.teamID
              )
            )
          ) {
            throw new Error('Surviving party is split between teams; group stopped');
          }
        }
        if (
          group.teamID !== teamID &&
          group.partyID != null &&
          group.players.length > 1 &&
          group.players.filter((p) => p.isLeader).length !== 1
        ) {
          throw new Error('Party leader is missing or ambiguous; team change stopped');
        }
      }
    }
    first = false;
    pending.sort((a, b) => Number(Boolean(b.isLeader)) - Number(Boolean(a.isLeader)));
    const eosID = pending[0].eosID;
    if (commanded.has(eosID))
      throw Object.assign(
        new Error('A team command was already sent for this target; no retry sent'),
        { stopShuffle: true }
      );
    const observation = snapshots.get(players);
    if (
      observation &&
      (server.rcon.getCommandVersion?.() !== observation.version ||
        performance.now() - observation.observedAt > snapshotMaxAgeMs)
    ) {
      players = await readSwitchRoster(server, wholeParties ? [] : roster);
      continue;
    }
    commanded.add(eosID);
    const before = players;
    let commandError;
    try {
      await server.rcon.switchTeam(eosID);
    } catch (error) {
      commandError = error;
    }
    try {
      players = await readSwitchRoster(server, wholeParties ? [] : before);
    } catch (error) {
      error.stopShuffle = true;
      throw error;
    }
    const changed = players.filter((candidate) => {
      const old = before.find((previous) => previous.eosID === candidate.eosID);
      return old && old.teamID !== candidate.teamID;
    });
    for (const changedPlayer of changed) {
      moved.add(changedPlayer.eosID);
      onMoved(changedPlayer);
    }
    if (wholeParties) {
      for (const target of targets) {
        if (!players.some((player) => player.eosID === target.eosID)) recordDeparture(target);
      }
    }
    if (changed.some((candidate) => !targetIDs.has(candidate.eosID))) {
      throw Object.assign(
        new Error('The server moved players outside the plan; further team changes stopped'),
        { stopShuffle: true }
      );
    }
    const observed = players.find((candidate) => candidate.eosID === eosID);
    if (wholeParties && !observed) continue;
    if (observed?.teamID !== teamID) {
      throw Object.assign(
        commandError ?? new Error('The requested team change was not confirmed; no retry sent'),
        { stopShuffle: true }
      );
    }
  }
}
