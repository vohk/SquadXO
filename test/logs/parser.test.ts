import {
  captureLines,
  markerLines,
  deployableLines,
  permissionLines,
  existingLines
} from './fixtures/patch-log.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SquadLogParser, parseSquadTimestamp } from '../../src/logs/parser.js';

const eos = '11111111111111111111111111111111';
const steam = '76561198000000001';
const prefix = '[2026.08.15-12.34.56:789][ 42]';

test('parses and safely correlates an EOS-first connection sequence', () => {
  const parser = new SquadLogParser();
  const lines = [
    `${prefix}LogNet: Join request: /Game?Name=Alpha?SplitscreenCount=1`,
    `${prefix}LogNet: Login request: ?Name=Alpha userId: RedpointEOS:${eos} platform: RedpointEOS`,
    `${prefix}LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/PersistentLevel.Alpha (IP: 127.0.0.1 | Online IDs:EOS: ${eos} steam: ${steam})`,
    `${prefix}LogNet: Join succeeded: Alpha`
  ];
  const events = lines.flatMap((line) => parser.parseLine(line));

  assert.deepEqual(
    events.map((event) => event.name),
    ['CLIENT_JOIN_REQUEST', 'CLIENT_LOGIN_REQUEST', 'PLAYER_CONNECTED', 'JOIN_SUCCEEDED']
  );
  assert.equal(events[2]?.data.eosID, eos);
  assert.equal(events[2]?.data.steamID, steam);
  assert.equal(events[3]?.data.eosID, eos);
  assert.equal(parser.statistics().warningCount, 0);
});

test('ports combat, round, and tick-rate event families', () => {
  const parser = new SquadLogParser();
  const lines = [
    `${prefix}LogSquad: Player:Victim ActualDamage=25.5 from Attacker (Online IDs:EOS: ${eos} steam: ${steam} | Player Controller ID: BP_PlayerController_C_1)caused by BP_Rifle_C`,
    `${prefix}LogSquadTrace: [DedicatedServer]Wound(): Player:Victim KillingDamage=25.5 from BP_PlayerController (Online IDs:EOS: ${eos} steam: ${steam} | Controller ID: BP_PlayerController_C_1) caused by BP_Rifle_C`,
    `${prefix}LogSquad: Medic (Online IDs:EOS: ${eos} steam: ${steam}) has revived Victim (Online IDs:EOS: ${eos} steam: ${steam}).`,
    `${prefix}LogSquad: USQGameState: Server Tick Rate: 49.8`,
    `${prefix}LogGameState: Match State Changed from InProgress to WaitingPostMatch`
  ];
  const events = lines.flatMap((line) => parser.parseLine(line));
  assert.deepEqual(
    events.map((event) => event.name),
    ['PLAYER_DAMAGED', 'PLAYER_WOUNDED', 'PLAYER_REVIVED', 'TICK_RATE', 'ROUND_ENDED']
  );
  assert.equal(events[1]?.data.attackerEOSID, eos);
  assert.equal(events[2]?.data.victimName, 'Victim');
});

test('accepts current Redpoint login, GameMode round, and environmental death forms', () => {
  const parser = new SquadLogParser();
  const lines = [
    `${prefix}LogNet: Join request: /Game?Name=Alpha?SplitscreenCount=1`,
    `${prefix}LogSquad: Login: NewPlayer: RedpointEOSIpNetConnection /Engine/Transient.RedpointEOSIpNetConnection_42`,
    `${prefix}LogGameMode: Display: Match State Changed from InProgress to WaitingPostMatch`,
    `${prefix}LogGameState: Match State Changed from InProgress to WaitingPostMatch`,
    `${prefix}LogSquadTrace: [DedicatedServer]Die(): Player:Victim KillingDamage=100.000000 from BP_PlayerController_C_42 (Online IDs: EOS: ${eos} steam: ${steam} | Contoller ID: BP_PlayerController_C_42) caused by nullptr`,
    `${prefix}LogSquad: Player:Victim ActualDamage=7.000000 from nullptr (Online IDs: INVALID | Player Controller ID: None)caused by Fence20`,
    `${prefix}LogSquadTrace: [DedicatedServer]Wound(): Player:Victim KillingDamage=7.000000 from nullptr (Online IDs: INVALID | Controller ID: None) caused by razorwire_rusty_3`,
    `${prefix}LogNet: UChannel::Close: Sending CloseBunch. PC: NULL`
  ];
  const events = lines.flatMap((line) => parser.parseLine(line));

  assert.deepEqual(
    events.map((event) => event.name),
    [
      'CLIENT_JOIN_REQUEST',
      'CLIENT_LOGIN',
      'ROUND_ENDED',
      'PLAYER_DIED',
      'PLAYER_DAMAGED',
      'PLAYER_WOUNDED'
    ]
  );
  assert.equal(events[3]?.data.weapon, 'nullptr');
  assert.equal(parser.statistics().warningCount, 0);
});

test('bounds abandoned correlations and reports important unmatched forms without raw data', () => {
  const parser = new SquadLogParser({ maximumCorrelations: 2, maximumWarnings: 2 });
  for (let chain = 1; chain <= 4; chain += 1) {
    parser.parseLine(
      `[2026.08.15-12.34.56:789][ ${chain}]LogNet: Join request: /Game?Name=P${chain}?SplitscreenCount=1`
    );
  }
  parser.parseLine(`${prefix}LogNet: Join request: changed-format`);
  const statistics = parser.statistics();
  assert.ok(statistics.correlationSize <= 2);
  assert.ok(statistics.peakCorrelationSize <= 2);
  assert.ok(statistics.warningCount >= 3);
  assert.deepEqual(Object.keys(statistics.warnings[0] ?? {}).sort(), ['category', 'line']);
});

test('parses Squad timestamps as UTC', () => {
  assert.equal(
    parseSquadTimestamp('2026.08.15-12.34.56:789').toISOString(),
    '2026-08-15T12:34:56.789Z'
  );
});

test('parses observed full capture and neutralization transitions', () => {
  const parser = new SquadLogParser();
  const events = captureLines.flatMap((line) => parser.parseLine(line));
  assert.deepEqual(
    events.map((event) => event.name),
    [
      'CAPTURE_ZONE_CAPTURED',
      'CAPTURE_ZONE_NEUTRALIZED',
      'CAPTURE_ZONE_CAPTURED',
      'CAPTURE_ZONE_NEUTRALIZED',
      'CAPTURE_ZONE_CAPTURED'
    ]
  );
  assert.ok(events.every((event) => event.data.zoneName === 'Walled Courts'));
  assert.deepEqual(
    events.map((event) => event.data.teamID),
    [1, 2, 2, 1, 1]
  );
  assert.equal(events[1]?.data.previousTeamID, 1);
  assert.equal(events[3]?.data.previousTeamID, 2);
  assert.equal(events[0]?.data.previousTeamID, undefined);
  assert.equal(parser.statistics().warningCount, 0);
});

test('parses observed map marker identity, team, type, signed coordinates and source', () => {
  const parser = new SquadLogParser();
  const events = markerLines.flatMap((line) => parser.parseLine(line));
  assert.equal(events.length, 6);
  assert.ok(events.every((event) => event.name === 'MAP_MARKER_PLACED'));
  const data = events[0]?.data;
  assert.ok(data);
  assert.equal(data.playerName, 'Sample Ω');
  assert.equal(data.playerTeamID, 2);
  assert.equal(data.teamID, 2);
  assert.equal(data.eosID, eos);
  assert.equal(data.steamID, steam);
  assert.equal(data.markerType, 'BP_MapMarker_POI');
  assert.deepEqual(data.location, { x: -4907, y: 16010, z: -13496 });
  assert.equal(data.chainID, 867);
  assert.equal((data.time as Date).toISOString(), '2026-10-01T18:25:56.734Z');
  assert.equal(data.raw, markerLines[0]);
  assert.deepEqual(events[5]?.data.location, { x: 4374, y: 11743, z: -13606 });
});

test('parses observed preplaced and dynamic deployables including team zero', () => {
  const parser = new SquadLogParser();
  const events = deployableLines.flatMap((line) => parser.parseLine(line));
  assert.deepEqual(
    events.map((event) => event.name),
    Array(3).fill('DEPLOYABLE_SPAWNED')
  );
  assert.deepEqual(
    events.map((event) => event.data.teamID),
    [1, 1, 0]
  );
  assert.equal(events[0]?.data.deployable, 'Team1PreplacedFOBRadio');
  assert.deepEqual(events[0]?.data.location, { x: 15160, y: -2150, z: -12980 });
  assert.equal(events[1]?.data.deployable, 'AmmoCrate_WPMC');
  assert.deepEqual(events[1]?.data.location, { x: 54010.85938, y: 5350.625, z: -13486.72168 });
  assert.equal(
    events[2]?.data.deployable,
    'AmmoCrateActor_GEN_VARIABLE_BP_Ammocrate_WPMC_C_CAT_42'
  );
});

test('accepts captured successful permission checks and the legacy wording', () => {
  for (const line of permissionLines) {
    const parser = new SquadLogParser();
    const prefix = line.match(/^\[[^\]]+\]\[[^\]]+\]/)?.[0];
    assert.ok(prefix);
    parser.parseLine(`${prefix}LogNet: Join request: /Game?Name=Sample?SplitscreenCount=1`);
    const [resolved] = parser.parseLine(line);
    assert.equal(resolved?.name, 'RESOLVED_EOS_ID');
    assert.equal(resolved?.data.eosID, eos);
    assert.equal(parser.statistics().matchedLines, 2);
    assert.equal(parser.statistics().warningCount, 0);
  }
});

test('continues parsing captured connection, possession and valid/invalid combat identities', () => {
  for (const line of existingLines) {
    const parser = new SquadLogParser();
    const [event] = parser.parseLine(line);
    assert.ok(event);
    assert.equal(event.data.raw, line);
    assert.ok(event.data.time instanceof Date);
    assert.equal(Number.isFinite(event.data.time.getTime()), true);
    if (line.includes('Online IDs: INVALID')) {
      assert.equal(event.data.attackerEOSID, undefined);
      assert.equal(event.data.attackerSteamID, undefined);
    } else if (/ActualDamage=|Wound\(\)|Die\(\)/.test(line)) {
      assert.equal(event.data.attackerEOSID, eos);
      assert.equal(event.data.attackerSteamID, steam);
    } else if (/On(?:Un)?Possess\(\)/.test(line)) {
      assert.equal(event.data.playerEOSID, eos);
      assert.equal(event.data.playerSteamID, steam);
    } else {
      assert.equal(event.data.eosID, eos);
      assert.equal(event.data.steamID, steam);
    }
  }
});

test('reports changed objective/deployable formats without copying raw lines into warnings', () => {
  const parser = new SquadLogParser();
  parser.parseLine(`${prefix}LogSquad: Capture zone changed-format`);
  parser.parseLine(`${prefix}LogSquad: Player Sample placed a new map marker changed-format`);
  parser.parseLine(`${prefix}LogSquad: Deployable Radio spawned for team changed-format`);
  assert.deepEqual(
    parser.statistics().warnings.map((warning) => warning.category),
    ['unmatched-capture-zone', 'unmatched-map-marker', 'unmatched-deployable-spawn']
  );
  assert.ok(parser.statistics().warnings.every((warning) => Object.keys(warning).length === 2));
});
