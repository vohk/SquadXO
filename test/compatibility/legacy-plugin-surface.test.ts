import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const serverSurface = new Set([
  'a2sPlayerCount',
  'admins',
  'currentLayer',
  'emit',
  'gameVersion',
  'getAdminPermsByAnyID',
  'getAdminPermsBySteamID',
  'getAdminsWithPermission',
  'getPlayerByAnyID',
  'getPlayerByCondition',
  'getPlayerByController',
  'getPlayerByEOSID',
  'getPlayerByName',
  'getPlayerByNameSuffix',
  'getPlayerBySteamID',
  'getSquadByCondition',
  'getSquadByID',
  'id',
  'layerHistory',
  'matchStartTime',
  'matchTimeout',
  'maxPlayers',
  'nextLayer',
  'nextLayerToBeVoted',
  'off',
  'on',
  'once',
  'options',
  'playerCount',
  'players',
  'plugins',
  'publicQueue',
  'publicSlots',
  'rcon',
  'removeEventListener',
  'reserveQueue',
  'reserveSlots',
  'serverName',
  'squads',
  'updateAdmins',
  'updatePlayerList',
  'updateSquadList'
]);

const rconSurface = new Set([
  'ban',
  'broadcast',
  'execute',
  'forceTeamChange',
  'getCurrentMap',
  'getListPlayers',
  'getNextMap',
  'getSquads',
  'kick',
  'setFogOfWar',
  'switchTeam',
  'warn'
]);

test('every source legacy plugin only calls facade members provided by compatibility runtime', async () => {
  const filenames = await readdir(resolve('squad-server/plugins'));
  const unsupported: string[] = [];
  for (const entry of filenames) {
    if (!entry.endsWith('.js') || entry.endsWith('.min.js')) continue;
    const filename = `squad-server/plugins/${entry}`;
    const source = await readFile(resolve(filename), 'utf8');
    for (const member of matches(source, /\bthis\.server\.([A-Za-z_$][\w$]*)/g)) {
      if (!serverSurface.has(member)) unsupported.push(`${filename}: server.${member}`);
    }
    for (const member of matches(source, /\bthis\.server\.rcon\.([A-Za-z_$][\w$]*)/g)) {
      if (!rconSurface.has(member)) unsupported.push(`${filename}: server.rcon.${member}`);
    }
  }
  assert.deepEqual(unsupported, []);
});

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)]
    .map((match) => match[1])
    .filter((member): member is string => member !== undefined);
}
