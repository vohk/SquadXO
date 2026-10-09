import fs from 'fs';
import path from 'path';
import util from 'util';

import Logger from 'core/logger';

import BasePlugin from './base-plugin.js';

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g');

function formatLogTimestamp(date = new Date()) {
  return date.toISOString();
}

function formatFilenameTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default class RollingFileLogger extends BasePlugin {
  static get description() {
    return (
      'The <code>RollingFileLogger</code> plugin writes SquadJS console output to a new timestamped log file ' +
      'each time SquadJS starts, and removes old log files beyond the configured retention count.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      logDir: {
        required: false,
        description: 'Directory where rolling SquadJS log files will be written.',
        default: './logs/squadjs'
      },
      retention: {
        required: false,
        description: 'Number of newest rolling log files to retain.',
        default: 10
      },
      filenamePrefix: {
        required: false,
        description: 'Prefix used for rolling log file names.',
        default: 'squadjs'
      },
      includeConsole: {
        required: false,
        description:
          'When true, direct <code>console.log</code>, <code>console.error</code>, and <code>console.trace</code> calls are also written to the file.',
        default: true
      },
      stripAnsi: {
        required: false,
        description:
          'When true, ANSI color and cursor control sequences are removed from file output.',
        default: true
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.logStream = null;
    this.logFilePath = null;
    this.originalLoggerVerbose = null;
    this.originalConsole = {};
    this.writingLoggerToConsole = false;
    this.isInstalled = false;
  }

  async prepareToMount() {
    await this.openLogFile();
    await this.pruneOldLogs();
    this.installLoggerWrapper();
    if (this.options.includeConsole) this.installConsoleWrappers();

    this.writeLine(
      [
        `Started rolling log at ${formatLogTimestamp()}`,
        `pid=${process.pid}`,
        `cwd=${process.cwd()}`,
        `file=${this.logFilePath}`
      ].join(' ')
    );
  }

  async unmount() {
    this.restoreWrappers();

    if (this.logStream) {
      await new Promise((resolve) => this.logStream.end(resolve));
      this.logStream = null;
    }
  }

  async openLogFile() {
    const logDir = path.resolve(this.options.logDir);
    await fs.promises.mkdir(logDir, { recursive: true });

    const filename = `${this.options.filenamePrefix}-${formatFilenameTimestamp()}.log`;
    this.logFilePath = path.join(logDir, filename);
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'wx' });

    await new Promise((resolve, reject) => {
      this.logStream.once('open', resolve);
      this.logStream.once('error', reject);
    });
  }

  async pruneOldLogs() {
    const retention = Math.max(1, Number(this.options.retention) || 1);
    const logDir = path.dirname(this.logFilePath);
    const prefixPattern = escapeRegExp(this.options.filenamePrefix);
    const logPattern = new RegExp(`^${prefixPattern}-.*\\.log$`);

    const files = await fs.promises.readdir(logDir, { withFileTypes: true });
    const logFiles = await Promise.all(
      files
        .filter((file) => file.isFile() && logPattern.test(file.name))
        .map(async (file) => {
          const filePath = path.join(logDir, file.name);
          const stats = await fs.promises.stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs };
        })
    );

    await Promise.all(
      logFiles
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(retention)
        .map((file) =>
          fs.promises.unlink(file.filePath).catch((err) => {
            this.writeLine(
              this.formatConsoleLine('console.error', ['Failed to prune log file', err])
            );
          })
        )
    );
  }

  installLoggerWrapper() {
    if (this.isInstalled) return;

    this.originalLoggerVerbose = Logger.verbose.bind(Logger);

    Logger.verbose = (module, verboseness, message, ...extras) => {
      if ((Logger.verboseness[module] || 1) >= verboseness) {
        this.writeLine(this.formatLoggerLine(module, verboseness, message, extras));
      }

      this.writingLoggerToConsole = true;
      try {
        return this.originalLoggerVerbose(module, verboseness, message, ...extras);
      } finally {
        this.writingLoggerToConsole = false;
      }
    };

    this.isInstalled = true;
  }

  installConsoleWrappers() {
    for (const method of ['log', 'error', 'trace']) {
      this.originalConsole[method] = console[method].bind(console);

      console[method] = (...args) => {
        if (!this.writingLoggerToConsole) {
          this.writeLine(this.formatConsoleLine(`console.${method}`, args));
        }

        return this.originalConsole[method](...args);
      };
    }
  }

  restoreWrappers() {
    if (this.originalLoggerVerbose) {
      Logger.verbose = this.originalLoggerVerbose;
      this.originalLoggerVerbose = null;
    }

    for (const [method, original] of Object.entries(this.originalConsole)) {
      console[method] = original;
    }
    this.originalConsole = {};
    this.isInstalled = false;
  }

  formatLoggerLine(module, verboseness, message, extras) {
    return [
      `[${formatLogTimestamp()}][${module}][${verboseness}]`,
      this.formatValue(message),
      ...extras.map((extra) => this.formatValue(extra))
    ]
      .filter((part) => part !== '')
      .join(' ');
  }

  formatConsoleLine(source, args) {
    return [`[${formatLogTimestamp()}][${source}]`, ...args.map((arg) => this.formatValue(arg))]
      .filter((part) => part !== '')
      .join(' ');
  }

  formatValue(value) {
    const formatted =
      typeof value === 'string'
        ? value
        : util.inspect(value, {
            colors: false,
            depth: null,
            breakLength: 120
          });

    return this.options.stripAnsi ? formatted.replace(ANSI_PATTERN, '') : formatted;
  }

  writeLine(line) {
    if (!this.logStream || this.logStream.destroyed) return;
    this.logStream.write(`${line}\n`);
  }
}
