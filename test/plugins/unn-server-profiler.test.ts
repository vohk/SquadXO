import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

interface ProfilerPlugin {
  captureTriggeredByDrop: boolean;
  captureQueueSamples: { elapsedMilliseconds: number; queueCount: number }[];
  channel: unknown;
  prepareToMount(): Promise<void>;
  mount(): Promise<void>;
  unmount(): Promise<void>;
  onProfilerStarting(): void;
  onProfilerEnded(match: Record<string, unknown>): Promise<void>;
  onTickRate(event: Record<string, unknown>): Promise<void>;
  resolveProfilerPath(path: string): string | null;
}

function profilerCsv(frameTimes: number[]): string {
  return [
    'FrameTime,PhysicalUsedMB,Replication/Connections,Exclusive/GameThread/Task,Exclusive/GameThread/EventWait,Exclusive/GameThread/ReplicateActor',
    ...frameTimes.map((frameTime, index) => `${frameTime},${2400 + index},5,2,700,300`)
  ].join('\n');
}

test('unnServerProfiler detects drops, reports ZIP and chart, and releases resources', async (t) => {
  const { default: unnServerProfiler } = (await import(
    pathToFileURL(resolve('squad-server/plugins/unn-server-profiler.js')).href
  )) as {
    default: new (
      server: unknown,
      options: Record<string, unknown>,
      connectors: Record<string, unknown>
    ) => ProfilerPlugin;
  };

  const root = await mkdtemp(join(tmpdir(), 'squadjs-profiler-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const squadGame = join(root, 'SquadGame');
  const profilerDirectory = join(squadGame, 'Saved', 'Profiling');
  await mkdir(profilerDirectory, { recursive: true });
  const csvPath = join(profilerDirectory, 'profile(1_2).csv');
  const csv = profilerCsv(Array.from({ length: 130 }, () => 15.625));
  await writeFile(csvPath, csv);

  const commands: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const channel = {
    send: async (message: Record<string, unknown>) => void sent.push(message)
  };
  const discord = {
    channels: { fetch: async () => channel }
  };
  const server = new EventEmitter() as EventEmitter & {
    players: unknown[];
    options: { logDir: string };
    currentLayer: { layerid: string };
    rcon: { execute(command: string): Promise<string> };
    removeEventListener(event: string, listener: (...arguments_: unknown[]) => void): EventEmitter;
  };
  server.players = [];
  server.options = { logDir: join(squadGame, 'Saved', 'Logs') };
  server.currentLayer = { layerid: 'TestLayer' };
  server.rcon = {
    execute: async (command) => {
      commands.push(command);
      return 'OK';
    }
  };
  server.removeEventListener = (event, listener) => server.removeListener(event, listener);

  const plugin = new unnServerProfiler(
    server,
    {
      discordClient: 'discord',
      channelID: 'channel-1',
      minimumPlayerCount: 1,
      profilingFileDurationMinutes: null,
      detectTPSDrops: true,
      compressionMethod: 'zip',
      generateCharts: true,
      overrideSquadGameDir: squadGame
    },
    { discord }
  );

  await plugin.prepareToMount();
  await plugin.mount();
  try {
    assert.deepEqual(commands, []);
    server.players.push({});
    server.emit('UPDATED_PLAYER_INFORMATION', {});
    await new Promise((resolveDelay) => setImmediate(resolveDelay));
    assert.deepEqual(commands, ['AdminProfileServerCSV start']);
    plugin.onProfilerStarting();
    server.emit('UPDATED_SERVER_INFORMATION', {
      serverName: 'Test Server',
      gameVersion: 'v10.5.3',
      publicQueue: 12,
      reserveQueue: 3
    });
    assert.equal(plugin.captureQueueSamples.length, 1);
    assert.equal(plugin.captureQueueSamples[0]?.queueCount, 15);
    for (let index = 0; index < 20; index += 1) await plugin.onTickRate({ tickRate: 40 });
    for (let index = 0; index < 3; index += 1) await plugin.onTickRate({ tickRate: 10 });
    assert.equal(plugin.captureTriggeredByDrop, true);
    assert.equal(commands.at(-1), 'AdminProfileServerCSV stop');

    await plugin.onProfilerEnded({
      groups: { csv_file_path: 'SquadGame/Saved/Profiling/profile(1_2).csv' }
    });
    assert.equal(sent.length, 1);
    const files = sent[0]!.files as { attachment: Buffer; name: string }[];
    assert.equal(files.length, 2);
    assert.equal(files[0]!.name, 'TestLayer_v10.5.3_profile(1_2)_chart.png');
    assert.deepEqual(files[0]!.attachment.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    assert.equal(files[1]!.name, 'TestLayer_v10.5.3_profile(1_2).zip');
    assert.equal(files[1]!.attachment.readUInt32LE(0), 0x04034b50);
    await assert.rejects(stat(csvPath));
    assert.equal(commands.at(-1), 'AdminProfileServerCSV start');
    assert.equal(
      plugin.resolveProfilerPath('../../outside.csv'),
      join(profilerDirectory, 'outside.csv')
    );
    assert.equal(plugin.resolveProfilerPath('/tmp/SquadGame/../../outside.csv'), null);

    await writeFile(csvPath, csv);
    plugin.channel = { send: async () => Promise.reject(new Error('Discord unavailable')) };
    plugin.onProfilerStarting();
    await plugin.onProfilerEnded({
      groups: { csv_file_path: 'SquadGame/Saved/Profiling/profile(1_2).csv' }
    });
    assert.equal((await stat(csvPath)).isFile(), true);
  } finally {
    await plugin.unmount();
  }

  assert.equal(server.listenerCount('RAW_LOG_LINE'), 0);
  assert.equal(server.listenerCount('TICK_RATE'), 0);
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);
  const zip = (sent[0]!.files as { attachment: Buffer }[])[1]!.attachment;
  assert.ok(zip.includes(Buffer.from('.csv')));
  const compressedSize = zip.readUInt32LE(18);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(
    inflateRawSync(zip.subarray(30 + nameLength, 30 + nameLength + compressedSize)).toString(),
    csv
  );
});

test('unnServerProfiler posts captures to text and version-specific forum destinations', async () => {
  const { createCsvChart, sendProfilerPayload, summarizeCsvProfile } = await import(
    pathToFileURL(resolve('squad-server/plugins/unn-server-profiler.js')).href
  );
  const csv = profilerCsv([
    ...Array.from({ length: 64 }, () => 15.625),
    ...Array.from({ length: 32 }, () => 15.625),
    500
  ]);
  const profile = summarizeCsvProfile(csv, [
    { elapsedMilliseconds: 0, queueCount: 10 },
    { elapsedMilliseconds: 1200, queueCount: 200 }
  ]);
  assert.equal(profile.samples.length, 2);
  assert.equal(profile.samples[0].effectiveTps, 64);
  assert.equal(profile.samples[0].worstFrameTime, 15.625);
  assert.equal(profile.samples[0].playerCount, 5);
  assert.equal(profile.samples[0].playerAndQueueCount, 15);
  assert.equal(profile.samples[1].effectiveTps, 33);
  assert.equal(profile.samples[1].worstFrameTime, 500);
  assert.equal(profile.samples[1].cpuTime, 2);
  assert.equal(profile.samples[1].playerAndQueueCount, 130);

  const chart = createCsvChart(csv, 'Jensens_Range_USA-PLA_v10.5.3_Profile(20260821_151504)', [
    { elapsedMilliseconds: 0, queueCount: 10 }
  ]).toString();
  assert.match(chart, />Players</);
  assert.match(chart, />Players \+ Queue</);
  assert.match(chart, />Memory Usage \(MB\)</);
  assert.match(chart, />Effective TPS \(1s\)</);
  assert.match(chart, />CPU Time \(ms\)</);
  assert.match(chart, />Worst Frame \(ms\)</);
  assert.match(chart, />500ms</);
  assert.match(chart, />500\.0 ms frame hitch</);
  assert.doesNotMatch(chart, />Tick Rate \(TPS\)</);
  assert.doesNotMatch(chart, /EventWait|ReplicateActor/);
  const payload = { content: 'Profiler capture', files: [] };
  const messages: unknown[] = [];
  await sendProfilerPayload(
    { send: async (message: unknown) => void messages.push(message) },
    payload,
    'TextCapture'
  );
  assert.deepEqual(messages, [payload]);

  const posts: unknown[] = [];
  const threadMessages: unknown[] = [];
  const versionThread = {
    id: 'thread-1',
    name: 'v10.5.2.650359.2681',
    archived: true,
    setArchived: async (archived: boolean) => {
      versionThread.archived = archived;
    },
    send: async (message: unknown) => void threadMessages.push(message)
  };
  await sendProfilerPayload(
    {
      threads: {
        cache: [],
        fetchActive: async () => ({ threads: [] }),
        fetchArchived: async () => ({ threads: [versionThread], hasMore: false }),
        create: async (post: unknown) => void posts.push(post)
      }
    },
    payload,
    'v10.5.2.650359.2681'
  );
  assert.equal(versionThread.archived, false);
  assert.deepEqual(threadMessages, [payload]);
  assert.equal(posts.length, 0);

  await sendProfilerPayload(
    {
      threads: {
        cache: [],
        fetchActive: async () => ({ threads: [] }),
        fetchArchived: async () => ({ threads: [], hasMore: false }),
        create: async (post: unknown) => void posts.push(post)
      }
    },
    payload,
    'v10.6.0'
  );
  assert.deepEqual(posts, [{ name: 'v10.6.0', message: payload }]);
});
