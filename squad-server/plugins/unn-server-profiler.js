import { AttachmentBuilder, WebhookClient } from 'discord.js';
import { readFile, unlink } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { deflateRaw as deflateRawCallback, gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import sharp from 'sharp';

import DiscordBasePlugin from './discord-base-plugin.js';

const gzip = promisify(gzipCallback);
const deflateRaw = promisify(deflateRawCallback);
const PROFILER_LINE =
  /LogCsvProfiler: Display: Capture (?<state>\w+)(?:\. CSV ID: (?<csv_id>\w+))?(?:\. Writing CSV to file : (?<csv_file_path>.+))?/;
const PROFILER_ALREADY_STOPPED =
  /LogCsvProfiler: Warning: Capture Stop requested, but no capture was running!/;
const PROFILER_ALREADY_RUNNING =
  /LogCsvProfiler: Warning: Capture start requested, but a capture was already running/;
const CHART_ATTRIBUTION = 'Made with ♥ by JetDave, modified by Unn.';
const HITCH_THRESHOLD_MILLISECONDS = 50;
const MAX_HITCH_LABELS = 10;
const MINIMUM_HITCH_LABEL_SPACING = 85;
const PLAYER_COUNT_CAP = 130;

export default class unnServerProfiler extends DiscordBasePlugin {
  static get description() {
    return 'Server profiler manager with TPS-drop detection and Discord reporting.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The Discord channel that receives profiler reports.',
        default: '',
        example: '667741905228136459'
      },
      enableFileCompression: {
        required: false,
        description: 'Compress profiler CSV attachments.',
        default: true
      },
      discordWebhook: {
        required: false,
        description: 'Optional Discord webhook URL used instead of channelID.',
        default: null
      },
      minimumPlayerCount: {
        required: false,
        description: 'Minimum connected players required to start profiling.',
        default: 1
      },
      profilingFileDurationMinutes: {
        required: false,
        description: 'Minutes per capture. Null disables timed capture rotation.',
        default: null
      },
      storeProfilerFilesOnlyIfTpsDropDetected: {
        required: false,
        description: 'Discard routine captures and report only captures stopped by a TPS drop.',
        default: false
      },
      overrideSquadGameDir: {
        required: false,
        description: 'Absolute path to the SquadGame directory.',
        default: null
      },
      detectTPSDrops: {
        required: false,
        description: 'Stop and report a capture when recent TPS falls 20% below its baseline.',
        default: false
      },
      simulateTpsDrops: {
        required: false,
        description: 'Inject occasional low TPS samples for test environments.',
        default: false
      },
      compressionMethod: {
        required: false,
        description: 'Attachment compression format: zip or gzip.',
        default: 'zip'
      },
      generateCharts: {
        required: false,
        description: 'Attach a lightweight SVG chart generated from numeric CSV columns.',
        default: true
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.profilerRunning = false;
    this.captureTriggeredByDrop = false;
    this.skipPlayerCheck = false;
    this.restartTimeout = null;
    this.startRequestTimeout = null;
    this.startRequestPending = false;
    this.tickRates = [];
    this.serverVersion = null;
    this.webhook = null;
    this.captureStartedAt = null;
    this.captureQueueSamples = [];
    this.latestQueueCount = null;

    this.onRawLogLine = this.onRawLogLine.bind(this);
    this.onRoundEnded = this.onRoundEnded.bind(this);
    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onTickRate = this.onTickRate.bind(this);
    this.onServerInformation = this.onServerInformation.bind(this);
    this.onProfilerStarting = this.onProfilerStarting.bind(this);
    this.onProfilerEnded = this.onProfilerEnded.bind(this);
    this.onProfilerAlreadyStopped = this.onProfilerAlreadyStopped.bind(this);
    this.restartProfiler = this.restartProfiler.bind(this);
  }

  async prepareToMount() {
    if (this.options.discordWebhook) {
      this.webhook = new WebhookClient({ url: this.options.discordWebhook });
      return;
    }
    await super.prepareToMount();
  }

  async mount() {
    this.server.on('RAW_LOG_LINE', this.onRawLogLine);
    this.server.on('ROUND_ENDED', this.onRoundEnded);
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.onPlayerConnected);
    this.server.on('UPDATED_SERVER_INFORMATION', this.onServerInformation);
    this.server.on('CSV_PROFILER_STARTING', this.onProfilerStarting);
    this.server.on('CSV_PROFILER_ENDED', this.onProfilerEnded);
    this.server.on('CSV_PROFILER_ALREADY_STOPPED', this.onProfilerAlreadyStopped);
    if (this.options.detectTPSDrops) this.server.on('TICK_RATE', this.onTickRate);
    await this.startProfiler();
    this.verbose(1, 'Mounted.');
  }

  async unmount() {
    this.clearRestartTimeout();
    this.clearStartRequest();
    this.server.removeEventListener('RAW_LOG_LINE', this.onRawLogLine);
    this.server.removeEventListener('ROUND_ENDED', this.onRoundEnded);
    this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeEventListener('UPDATED_PLAYER_INFORMATION', this.onPlayerConnected);
    this.server.removeEventListener('UPDATED_SERVER_INFORMATION', this.onServerInformation);
    this.server.removeEventListener('CSV_PROFILER_STARTING', this.onProfilerStarting);
    this.server.removeEventListener('CSV_PROFILER_ENDED', this.onProfilerEnded);
    this.server.removeEventListener('CSV_PROFILER_ALREADY_STOPPED', this.onProfilerAlreadyStopped);
    this.server.removeEventListener('TICK_RATE', this.onTickRate);
    this.finishCaptureTracking();
    this.webhook?.destroy();
    this.webhook = null;
    this.verbose(1, 'Un-mounted.');
  }

  async startProfiler() {
    if (
      this.profilerRunning ||
      this.startRequestPending ||
      (!this.skipPlayerCheck && this.server.players.length < this.options.minimumPlayerCount)
    ) {
      return;
    }
    this.skipPlayerCheck = false;
    this.startRequestPending = true;
    try {
      await this.server.rcon.execute('AdminProfileServerCSV start');
      this.verbose(1, 'Requested CSV profiler start.');
      this.startRequestTimeout = setTimeout(() => {
        this.startRequestTimeout = null;
        this.startRequestPending = false;
        void this.startProfiler().catch((error) => {
          this.verbose(1, 'Could not retry CSV profiler start:', error);
        });
      }, 15_000);
    } catch (error) {
      this.clearStartRequest();
      throw error;
    }
  }

  async stopProfiler() {
    await this.server.rcon.execute('AdminProfileServerCSV stop');
  }

  async restartProfiler() {
    this.clearRestartTimeout();
    await this.stopProfiler();
  }

  async onRoundEnded() {
    if (!this.profilerRunning) return;
    this.skipPlayerCheck = true;
    await this.restartProfiler();
  }

  async onPlayerConnected() {
    await this.startProfiler();
  }

  onServerInformation(information) {
    this.serverVersion = information.gameVersion ?? information.GameVersion_s ?? this.serverVersion;
    const queueCount = serverQueueCount(information);
    if (queueCount === null) return;
    this.latestQueueCount = queueCount;
    this.recordQueueSample(queueCount);
  }

  onProfilerStarting() {
    this.clearStartRequest();
    this.profilerRunning = true;
    this.captureTriggeredByDrop = false;
    this.beginCaptureTracking();
    this.clearRestartTimeout();
    const minutes = Number(this.options.profilingFileDurationMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      this.restartTimeout = setTimeout(this.restartProfiler, minutes * 60_000);
    }
  }

  onProfilerAlreadyStopped() {
    this.clearStartRequest();
    this.profilerRunning = false;
    this.finishCaptureTracking();
    this.clearRestartTimeout();
    void this.startProfiler().catch((error) => {
      this.verbose(1, 'Could not restart CSV profiler:', error);
    });
  }

  async onProfilerEnded(match) {
    this.clearStartRequest();
    this.profilerRunning = false;
    const queueSamples = this.finishCaptureTracking();
    this.clearRestartTimeout();
    const rawPath = match?.groups?.csv_file_path;
    const profilerPath = this.resolveProfilerPath(rawPath);
    if (!profilerPath) {
      this.verbose(1, `Ignoring profiler result with an unsafe or missing path: ${rawPath ?? ''}`);
      await this.startProfiler();
      return;
    }

    const shouldReport =
      !this.options.storeProfilerFilesOnlyIfTpsDropDetected || this.captureTriggeredByDrop;
    let removeProfilerFile = !shouldReport;
    try {
      if (shouldReport) {
        await this.sendProfilerReport(profilerPath, queueSamples);
        removeProfilerFile = true;
      }
    } catch (error) {
      this.verbose(
        1,
        `Could not send profiler report; retaining ${profilerPath}: ${error.message}`
      );
    } finally {
      if (removeProfilerFile) await unlink(profilerPath).catch(() => undefined);
      this.captureTriggeredByDrop = false;
      await this.startProfiler();
    }
  }

  async onTickRate(event) {
    let tickRate = Number(event?.tickRate);
    if (!Number.isFinite(tickRate)) return;
    if (this.options.simulateTpsDrops && Math.random() < 0.05) tickRate *= 0.5;
    this.tickRates.push(tickRate);
    if (this.tickRates.length > 100) this.tickRates.shift();
    if (this.tickRates.length < 20 || this.captureTriggeredByDrop) return;

    const baseline = average(this.tickRates.slice(-20));
    const recent = average(this.tickRates.slice(-3));
    if (baseline > 0 && recent < baseline * 0.8) {
      this.captureTriggeredByDrop = true;
      this.server.emit('TPS_DROP', { ...event, averageTickRate: baseline, recentTickRate: recent });
      if (this.profilerRunning) await this.stopProfiler();
    }
  }

  onRawLogLine(line) {
    let match = String(line).match(PROFILER_LINE);
    if (match) {
      this.server.emit(`CSV_PROFILER_${match.groups.state.toUpperCase()}`, match);
      return;
    }
    match = String(line).match(PROFILER_ALREADY_STOPPED);
    if (match) {
      this.server.emit('CSV_PROFILER_ALREADY_STOPPED', match);
      return;
    }
    match = String(line).match(PROFILER_ALREADY_RUNNING);
    if (match) {
      this.clearStartRequest();
      this.profilerRunning = true;
      this.beginCaptureTracking();
      this.server.emit('CSV_PROFILER_ALREADY_RUNNING', match);
    }
  }

  resolveProfilerPath(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
    const squadGameDir = this.getSquadGameDir();
    if (!squadGameDir) return null;
    const normalized = rawPath.trim().replaceAll('\\', '/');
    const squadIndex = normalized.toLowerCase().indexOf('squadgame/');
    const candidate =
      squadIndex === -1
        ? resolve(squadGameDir, 'Saved', 'Profiling', basename(normalized))
        : resolve(dirname(squadGameDir), normalized.slice(squadIndex));
    const pathWithinGame = relative(squadGameDir, candidate);
    return pathWithinGame && !pathWithinGame.startsWith(`..${sep}`) && pathWithinGame !== '..'
      ? candidate
      : null;
  }

  getSquadGameDir() {
    if (this.options.overrideSquadGameDir) return resolve(this.options.overrideSquadGameDir);
    const logDir = this.server.options?.logDir;
    if (typeof logDir !== 'string') return null;
    const normalized = logDir.replaceAll('\\', '/');
    const match = normalized.match(/^(.*?\/SquadGame)(?:\/|$)/i);
    return match ? resolve(match[1]) : null;
  }

  async sendProfilerReport(csvPath, queueSamples = []) {
    const csv = await readFile(csvPath);
    const baseName = this.reportBaseName(basename(csvPath));
    const attachments = [];
    if (this.options.generateCharts) {
      const chart = createCsvChart(csv.toString('utf8'), baseName, queueSamples);
      if (chart) {
        const png = await sharp(chart).png().toBuffer();
        attachments.push(new AttachmentBuilder(png, { name: `${baseName}_chart.png` }));
      }
    }

    const { buffer, extension } = await compressAttachment(
      csv,
      this.options.enableFileCompression,
      this.options.compressionMethod,
      basename(csvPath)
    );
    attachments.push(new AttachmentBuilder(buffer, { name: `${baseName}${extension}` }));
    const destination = this.webhook ?? this.channel;
    if (!destination) throw new Error('Discord destination is not available');
    await sendProfilerPayload(
      destination,
      {
        files: attachments
      },
      this.serverVersion ?? 'UnknownVersion'
    );
  }

  reportBaseName(csvName) {
    const layer =
      this.server.currentLayer?.layerid ?? this.server.currentLayer?.name ?? 'UnknownLayer';
    return [layer, this.serverVersion, csvName.replace(/\.csv$/i, '')]
      .filter(Boolean)
      .map((part) => sanitizeFilename(String(part)))
      .join('_');
  }

  clearRestartTimeout() {
    if (this.restartTimeout) clearTimeout(this.restartTimeout);
    this.restartTimeout = null;
  }

  clearStartRequest() {
    if (this.startRequestTimeout) clearTimeout(this.startRequestTimeout);
    this.startRequestTimeout = null;
    this.startRequestPending = false;
  }

  beginCaptureTracking() {
    this.captureStartedAt = Date.now();
    this.captureQueueSamples = [];
    const queueCount = this.latestQueueCount ?? serverQueueCount(this.server);
    if (queueCount !== null) {
      this.latestQueueCount = queueCount;
      this.recordQueueSample(queueCount, 0);
    }
  }

  recordQueueSample(queueCount, elapsedMilliseconds = null) {
    if (!this.profilerRunning || this.captureStartedAt === null) return;
    const elapsed =
      elapsedMilliseconds ?? Math.max(0, Date.now() - Number(this.captureStartedAt));
    const previous = this.captureQueueSamples.at(-1);
    if (previous?.queueCount === queueCount) return;
    this.captureQueueSamples.push({ elapsedMilliseconds: elapsed, queueCount });
  }

  finishCaptureTracking() {
    const samples = this.captureQueueSamples;
    this.captureStartedAt = null;
    this.captureQueueSamples = [];
    return samples;
  }
}

export async function sendProfilerPayload(destination, payload, forumTitle) {
  if (typeof destination?.send === 'function') {
    await destination.send(payload);
    return;
  }
  if (typeof destination?.threads?.create === 'function') {
    const title = String(forumTitle || 'UnknownVersion').trim().slice(0, 100);
    const existingThread = await findForumThread(destination.threads, title);
    if (existingThread) {
      if (existingThread.archived && typeof existingThread.setArchived === 'function') {
        await existingThread.setArchived(false);
      }
      if (typeof existingThread.send !== 'function') {
        throw new Error(`Discord forum post ${title} does not accept messages`);
      }
      await existingThread.send(payload);
      return;
    }
    await destination.threads.create({
      name: title,
      message: payload
    });
    return;
  }
  throw new Error('Discord destination does not support messages or forum posts');
}

async function findForumThread(threads, title) {
  let thread = findNamedThread(threads.cache, title);
  if (thread) return thread;

  if (typeof threads.fetchActive === 'function') {
    const active = await threads.fetchActive();
    thread = findNamedThread(active?.threads ?? active, title);
    if (thread) return thread;
  }

  if (typeof threads.fetchArchived !== 'function') return null;
  let before;
  do {
    const archived = await threads.fetchArchived({ type: 'public', limit: 100, before });
    const archivedThreads = archived?.threads ?? archived;
    thread = findNamedThread(archivedThreads, title);
    if (thread) return thread;
    if (!archived?.hasMore) return null;
    before = [...collectionValues(archivedThreads)].at(-1)?.id;
  } while (before);
  return null;
}

function findNamedThread(collection, title) {
  if (typeof collection?.find === 'function') {
    return collection.find((thread) => thread?.name === title) ?? null;
  }
  for (const thread of collectionValues(collection)) {
    if (thread?.name === title) return thread;
  }
  return null;
}

function collectionValues(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return collection.values();
  if (Array.isArray(collection)) return collection;
  return [];
}

async function compressAttachment(csv, enabled, method, csvName) {
  if (!enabled) return { buffer: csv, extension: '.csv' };
  if (String(method).toLowerCase() === 'gzip') {
    return { buffer: await gzip(csv), extension: '.csv.gz' };
  }
  return { buffer: createZip(csvName, csv, await deflateRaw(csv)), extension: '.zip' };
}

function createZip(fileName, contents, compressed) {
  const name = Buffer.from(sanitizeFilename(fileName));
  const crc = crc32(contents);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createCsvChart(csv, title, queueSamples = []) {
  const profile = summarizeCsvProfile(csv, queueSamples);
  if (!profile || profile.samples.length < 2) return null;
  const { samples, durationMilliseconds } = profile;

  const width = 1920;
  const height = 1080;
  const plot = { left: 260, top: 135, right: 1605, bottom: 983 };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const yMaximum = 100;
  const durationMinutes = durationMilliseconds / 60_000;
  const maximumMemory = Math.max(0, ...samples.map(({ memory }) => memory ?? 0));
  const memoryScale = maximumMemory > 0 ? (yMaximum * 0.8) / maximumMemory : 1;
  const playerScale = yMaximum / PLAYER_COUNT_CAP;
  const x = (milliseconds) =>
    plot.left + (milliseconds / Math.max(1, durationMilliseconds)) * plotWidth;
  const y = (value) =>
    plot.bottom - (Math.max(0, Math.min(yMaximum, value)) / yMaximum) * plotHeight;

  const series = [
    {
      label: 'Players',
      color: '#cc66cc',
      stepped: true,
      values: samples
        .filter(({ playerCount }) => playerCount !== null)
        .map(({ elapsedMilliseconds, playerCount }) => ({
          x: x(elapsedMilliseconds),
          y: y(playerCount * playerScale)
        }))
    },
    {
      label: 'Players + Queue',
      color: '#9f7aea',
      stepped: true,
      values: samples
        .filter(({ playerAndQueueCount }) => playerAndQueueCount !== null)
        .map(({ elapsedMilliseconds, playerAndQueueCount }) => ({
          x: x(elapsedMilliseconds),
          y: y(playerAndQueueCount * playerScale)
        }))
    },
    {
      label: 'Memory Usage (MB)',
      color: '#ff3366',
      values: samples
        .filter(({ memory }) => memory !== null)
        .map(({ elapsedMilliseconds, memory }) => ({
          x: x(elapsedMilliseconds),
          y: y(memory * memoryScale)
        }))
    },
    {
      label: 'Effective TPS (1s)',
      color: '#4ddbd3',
      strokeWidth: 3,
      values: samples.map(({ elapsedMilliseconds, effectiveTps }) => ({
        x: x(elapsedMilliseconds),
        y: y(effectiveTps)
      }))
    },
    {
      label: 'CPU Time (ms)',
      color: '#e87500',
      values: samples.map(({ elapsedMilliseconds, cpuTime }) => ({
        x: x(elapsedMilliseconds),
        y: y(cpuTime)
      }))
    },
    {
      label: 'Worst Frame (ms)',
      color: '#ffd24d',
      strokeWidth: 2,
      values: samples.map(({ elapsedMilliseconds, worstFrameTime }) => ({
        x: x(elapsedMilliseconds),
        y: y(worstFrameTime)
      }))
    }
  ].filter(({ values }) => values.length > 1);
  if (!series.length) return null;

  const horizontalGrid = Array.from({ length: 21 }, (_, index) => {
    const value = index * 5;
    const lineY = y(value);
    const players = Math.round(value / playerScale);
    const memory = Math.round(value / memoryScale);
    return `<line x1="${plot.left}" y1="${lineY}" x2="${plot.right}" y2="${lineY}" stroke="#334047" stroke-width="1"/><text x="${plot.left - 12}" y="${lineY + 8}" text-anchor="end" fill="#cccccc" font-size="23">${value} TPS | ${players}p</text><text x="${plot.right + 12}" y="${lineY + 8}" fill="#cccccc" font-size="23">${memory}MB | ${value.toFixed(1)}ms</text>`;
  }).join('');
  const xStep = chartMinuteStep(durationMinutes);
  const verticalGrid = [];
  for (let minute = 0; minute <= durationMinutes + xStep * 0.05; minute += xStep) {
    const lineX = plot.left + (minute / Math.max(durationMinutes, xStep)) * plotWidth;
    verticalGrid.push(
      `<line x1="${lineX}" y1="${plot.top}" x2="${lineX}" y2="${plot.bottom}" stroke="#34373b" stroke-width="1"/><text x="${lineX}" y="${plot.bottom + 34}" text-anchor="middle" fill="#eeeeee" font-size="23">${minute}</text>`
    );
  }
  const polylines = series
    .map(
      ({ color, stepped, strokeWidth = 3, values }) =>
        `<polyline fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round" points="${chartPoints(values, stepped)}"/>`
    )
    .join('');
  const hitchMarkers = samples
    .filter(({ worstFrameTime }) => worstFrameTime >= HITCH_THRESHOLD_MILLISECONDS)
    .map(({ worstFrameElapsedMilliseconds, worstFrameTime }) => {
      const markerX = x(worstFrameElapsedMilliseconds);
      const markerY = y(worstFrameTime);
      return `<line x1="${markerX}" y1="${plot.bottom}" x2="${markerX}" y2="${markerY}" stroke="#ff5252" stroke-width="2" opacity="0.55"/><circle cx="${markerX}" cy="${markerY}" r="5" fill="#ff5252"><title>${worstFrameTime.toFixed(1)} ms frame hitch</title></circle>`;
    })
    .join('');
  const hitchLabels = selectHitchLabels(samples, x)
    .map(({ worstFrameElapsedMilliseconds, worstFrameTime }) => {
      const labelX = x(worstFrameElapsedMilliseconds);
      return `<text x="${labelX}" y="${plot.top + 18}" text-anchor="middle" fill="#ff8a80" font-size="16" font-weight="700">${Math.round(worstFrameTime)}ms</text>`;
    })
    .join('');
  const legendWidths = [105, 170, 190, 185, 155, 185];
  const legendStart = (width - legendWidths.reduce((sum, value) => sum + value, 0)) / 2;
  let legendX = legendStart;
  const legend = series
    .map(({ color, label }, index) => {
      const item = `<circle cx="${legendX + 10}" cy="116" r="10" fill="none" stroke="${color}" stroke-width="3"/><text x="${legendX + 26}" y="123" fill="#eeeeee" font-size="17">${escapeXml(label)}</text>`;
      legendX += legendWidths[index] ?? 170;
      return item;
    })
    .join('');

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif"><rect width="100%" height="100%" fill="#18181b"/><text x="${width / 2}" y="74" text-anchor="middle" fill="#f5f5f5" font-size="30" font-weight="700">${escapeXml(title)}</text>${legend}${horizontalGrid}${verticalGrid.join('')}${polylines}${hitchMarkers}${hitchLabels}<text x="${(plot.left + plot.right) / 2}" y="${plot.bottom + 65}" text-anchor="middle" fill="#eeeeee" font-size="20">Time (minutes)</text><text x="82" y="${(plot.top + plot.bottom) / 2}" text-anchor="middle" fill="#cccccc" font-size="27" transform="rotate(-90 82 ${(plot.top + plot.bottom) / 2})">Effective TPS, Players</text><text x="1840" y="${(plot.top + plot.bottom) / 2}" text-anchor="middle" fill="#cccccc" font-size="27" transform="rotate(90 1840 ${(plot.top + plot.bottom) / 2})">Memory, CPU, Worst Frame</text><text x="1860" y="1060" text-anchor="end" fill="#777777" font-size="16">${escapeXml(CHART_ATTRIBUTION)}</text></svg>`
  );
}

export function summarizeCsvProfile(csv, queueSamples = []) {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 3) return null;
  const header = splitCsvRow(rows[0]).map((value) => value.replace(/^\uFEFF/, '').trim());
  const frameTimeIndex = header.indexOf('FrameTime');
  if (frameTimeIndex === -1) return null;
  const memoryIndex = header.indexOf('PhysicalUsedMB');
  const playerCountIndex = header.indexOf('Replication/Connections');
  const cpuIndexes = header
    .map((name, index) => ({ name, index }))
    .filter(
      ({ name }) =>
        name.startsWith('Exclusive/GameThread/') &&
        !name.startsWith('Exclusive/GameThread/EventWait') &&
        !name.startsWith('Exclusive/GameThread/ReplicateActor')
    )
    .map(({ index }) => index);

  const samples = [];
  let elapsedMilliseconds = 0;
  let bucket = null;
  for (const rawRow of rows.slice(1)) {
    const row = splitCsvRow(rawRow);
    const frameTime = Number(row[frameTimeIndex]);
    if (!Number.isFinite(frameTime) || frameTime <= 0) continue;
    const frameStartMilliseconds = elapsedMilliseconds;
    const bucketIndex = Math.floor(frameStartMilliseconds / 1000);
    if (!bucket || bucket.index !== bucketIndex) {
      if (bucket) samples.push(finalizeChartBucket(bucket));
      bucket = {
        index: bucketIndex,
        frameCount: 0,
        frameTimeTotal: 0,
        cpuTimeTotal: 0,
        worstFrameTime: 0,
        worstFrameElapsedMilliseconds: frameStartMilliseconds,
        elapsedMilliseconds: frameStartMilliseconds,
        memory: null,
        playerCount: null
      };
    }

    const cpuTime = cpuIndexes.reduce((sum, index) => sum + (Number(row[index]) || 0), 0);
    elapsedMilliseconds += frameTime;
    bucket.frameCount += 1;
    bucket.frameTimeTotal += frameTime;
    bucket.cpuTimeTotal += cpuTime;
    bucket.elapsedMilliseconds = elapsedMilliseconds;
    bucket.memory = memoryIndex === -1 ? null : finiteNumber(row[memoryIndex]);
    bucket.playerCount = playerCountIndex === -1 ? null : finiteNumber(row[playerCountIndex]);
    if (frameTime > bucket.worstFrameTime) {
      bucket.worstFrameTime = frameTime;
      bucket.worstFrameElapsedMilliseconds = frameStartMilliseconds;
    }
  }
  if (bucket) samples.push(finalizeChartBucket(bucket));
  if (!samples.length) return null;
  return {
    samples: applyQueueSamples(samples, queueSamples),
    durationMilliseconds: elapsedMilliseconds
  };
}

function finalizeChartBucket(bucket) {
  return {
    elapsedMilliseconds: bucket.elapsedMilliseconds,
    effectiveTps: (bucket.frameCount * 1000) / bucket.frameTimeTotal,
    cpuTime: bucket.cpuTimeTotal / bucket.frameCount,
    memory: bucket.memory,
    playerCount: bucket.playerCount,
    worstFrameTime: bucket.worstFrameTime,
    worstFrameElapsedMilliseconds: bucket.worstFrameElapsedMilliseconds
  };
}

function selectHitchLabels(samples, x) {
  const selected = [];
  for (const sample of [...samples]
    .filter(({ worstFrameTime }) => worstFrameTime >= HITCH_THRESHOLD_MILLISECONDS)
    .sort((left, right) => right.worstFrameTime - left.worstFrameTime)) {
    const sampleX = x(sample.worstFrameElapsedMilliseconds);
    if (
      selected.every(
        ({ worstFrameElapsedMilliseconds }) =>
          Math.abs(x(worstFrameElapsedMilliseconds) - sampleX) >= MINIMUM_HITCH_LABEL_SPACING
      )
    ) {
      selected.push(sample);
      if (selected.length === MAX_HITCH_LABELS) break;
    }
  }
  return selected.sort(
    (left, right) => left.worstFrameElapsedMilliseconds - right.worstFrameElapsedMilliseconds
  );
}

function applyQueueSamples(samples, queueSamples) {
  const normalizedQueueSamples = queueSamples
    .map(({ elapsedMilliseconds, queueCount }) => ({
      elapsedMilliseconds: Number(elapsedMilliseconds),
      queueCount: Number(queueCount)
    }))
    .filter(
      ({ elapsedMilliseconds, queueCount }) =>
        Number.isFinite(elapsedMilliseconds) &&
        elapsedMilliseconds >= 0 &&
        Number.isFinite(queueCount) &&
        queueCount >= 0
    )
    .sort((left, right) => left.elapsedMilliseconds - right.elapsedMilliseconds);
  let queueIndex = -1;
  return samples.map((sample) => {
    while (
      normalizedQueueSamples[queueIndex + 1]?.elapsedMilliseconds <= sample.elapsedMilliseconds
    ) {
      queueIndex += 1;
    }
    const playerCount =
      sample.playerCount === null
        ? null
        : Math.min(PLAYER_COUNT_CAP, Math.max(0, sample.playerCount));
    const queueCount = normalizedQueueSamples[queueIndex]?.queueCount;
    return {
      ...sample,
      playerCount,
      playerAndQueueCount:
        playerCount === null || queueCount === undefined
          ? null
          : Math.min(PLAYER_COUNT_CAP, playerCount + queueCount)
    };
  });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serverQueueCount(information) {
  const publicQueue = finiteNumber(information?.publicQueue ?? information?.PublicQueue_I);
  const reserveQueue = finiteNumber(information?.reserveQueue ?? information?.ReservedQueue_I);
  if (publicQueue === null && reserveQueue === null) return null;
  return Math.max(0, (publicQueue ?? 0) + (reserveQueue ?? 0));
}

function chartMinuteStep(durationMinutes) {
  if (durationMinutes <= 10) return 1;
  if (durationMinutes <= 35) return 5;
  if (durationMinutes <= 60) return 10;
  if (durationMinutes <= 120) return 20;
  return Math.max(30, Math.ceil(durationMinutes / 6 / 10) * 10);
}

function chartPoints(values, stepped = false) {
  if (!stepped) return values.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return values
    .flatMap(({ x, y }, index) => {
      if (index === 0) return [`${x.toFixed(1)},${y.toFixed(1)}`];
      const previous = values[index - 1];
      return [`${x.toFixed(1)},${previous.y.toFixed(1)}`, `${x.toFixed(1)},${y.toFixed(1)}`];
    })
    .join(' ');
}

function splitCsvRow(row) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"' && quoted && row[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else value += character;
  }
  values.push(value);
  return values;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sanitizeFilename(value) {
  return value.replaceAll(/[^a-zA-Z0-9_.()-]+/g, '-').replaceAll(/^-+|-+$/g, '') || 'profile';
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
