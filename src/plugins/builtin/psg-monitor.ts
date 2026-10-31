import { DataTypes, type Model, type ModelStatic, type Sequelize } from 'sequelize';
import { configuredDbSchema } from '../../database/schema.js';
import { definePlugin, type PluginContext } from '../api.js';

// Native successor to the legacy PteroMonitor (renamed psgMonitor to tell them apart) for the PSG Hosting panel fork, which serves
// live usage from the node: GET {nodeUrl}/api/user/servers/{uuid}/resources.
// Rows keep the legacy PM_ServerUsages layout so existing history and queries stay valid.
const options = {
  nodeUrl: {
    type: 'string',
    required: true,
    description:
      'Base URL of the node hosting the server, including port (the `url` of the matching item from the panel node-tokens endpoint).'
  },
  serverUUID: {
    type: 'string',
    required: true,
    description: 'The UUID of the server to pull stats from.'
  },
  apiToken: {
    type: 'string',
    required: true,
    description: 'A client API key, sent as a bearer token. Its allowed IP addresses apply.'
  },
  updateInterval: {
    type: 'number',
    default: 10,
    description: 'The update interval for the server to pull stats from (in seconds).'
  },
  fetchTimeout: {
    type: 'number',
    default: 8,
    description: 'Maximum time to wait for the node API before skipping this sample (in seconds).'
  },
  overrideServerID: {
    type: 'number',
    description:
      'Server ID stored with each sample. Set it to the same value as DBLog overrideServerID; defaults to the instance server ID.'
  }
} as const;

const connectors = {
  database: {
    type: 'sequelize',
    description: 'Database that receives samples. Use the same connection as DBLog.'
  }
} as const;

type PsgMonitorOptions = {
  readonly nodeUrl: string;
  readonly serverUUID: string;
  readonly apiToken: string;
  readonly updateInterval: number;
  readonly fetchTimeout: number;
  readonly overrideServerID?: number;
};

type PsgMonitorContext = PluginContext<PsgMonitorOptions, typeof connectors>;
type DbModel = ModelStatic<Model<Record<string, unknown>, Record<string, unknown>>>;

export interface ResourceSample {
  readonly status: number;
  readonly memory: number;
  readonly cpu: number;
  readonly disk: number;
}

const STATUS_CODES: Readonly<Record<string, number>> = {
  offline: 0,
  stopping: 1,
  starting: 2,
  running: 3
};

export function normalizeStatus(state: unknown): number {
  if (typeof state !== 'string') return 0;
  return STATUS_CODES[state.toLowerCase()] ?? 0;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Maps the node `NodeUserServerResources` body to a stored sample. */
export function parseResourcePayload(json: unknown): ResourceSample {
  const body = (typeof json === 'object' && json !== null ? json : {}) as {
    state?: unknown;
    resources?: Record<string, unknown> | null;
  };
  const resources = body.resources ?? {};
  return {
    status: normalizeStatus(body.state),
    memory: finiteNumber(resources.memory_bytes),
    cpu: finiteNumber(resources.cpu_absolute),
    disk: finiteNumber(resources.disk_bytes)
  };
}

export function resourcesUrl(nodeUrl: string, serverUUID: string): string {
  return `${nodeUrl.replace(/\/+$/, '')}/api/user/servers/${encodeURIComponent(serverUUID)}/resources`;
}

function validateOptions(opts: PsgMonitorOptions): void {
  for (const name of ['nodeUrl', 'serverUUID', 'apiToken'] as const) {
    if (!opts[name].trim()) throw new Error(`PsgMonitor option ${name} must not be empty`);
  }
  if (!/^https?:\/\//i.test(opts.nodeUrl)) {
    throw new Error('PsgMonitor option nodeUrl must start with http:// or https://');
  }
  if (!(opts.updateInterval > 0)) {
    throw new Error('PsgMonitor option updateInterval must be greater than zero');
  }
}

function defineModels(sequelize: Sequelize): { usage: DbModel; match: DbModel } {
  const schema = configuredDbSchema(sequelize);
  const common = { timestamps: false, ...(schema ? { schema } : {}) } as const;
  const usage = sequelize.define(
    'PM_ServerUsage',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      time: DataTypes.DATE,
      server: DataTypes.INTEGER,
      match: DataTypes.INTEGER,
      status: DataTypes.INTEGER,
      memory: DataTypes.BIGINT,
      cpu: DataTypes.FLOAT,
      disk: DataTypes.BIGINT
    },
    { ...common, tableName: 'PM_ServerUsages' }
  ) as DbModel;
  // Read-only view of DBLog's match table, used to tag samples with the open match.
  const match = sequelize.define(
    'PM_DBLogMatch',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      server: DataTypes.INTEGER,
      startTime: DataTypes.DATE,
      endTime: DataTypes.DATE
    },
    { ...common, tableName: 'DBLog_Matches' }
  ) as DbModel;
  return { usage, match };
}

export default definePlugin({
  apiVersion: 1,
  name: 'psgMonitor',
  description:
    'Monitors server resource usage through the PSG Hosting node API and saves it to the database.',
  options,
  connectors,
  create() {
    let warnedMatchLookup = false;

    async function currentMatch(
      context: PsgMonitorContext,
      match: DbModel,
      serverID: number
    ): Promise<number | null> {
      try {
        const row = await match.findOne({
          where: { server: serverID, endTime: null },
          order: [['id', 'DESC']]
        });
        const id = row?.get('id');
        return typeof id === 'number' ? id : null;
      } catch (error) {
        if (!warnedMatchLookup) {
          warnedMatchLookup = true;
          context.logger.warn('Could not look up the current DBLog match; storing null', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return null;
      }
    }

    async function poll(
      context: PsgMonitorContext,
      models: { usage: DbModel; match: DbModel },
      serverID: number
    ): Promise<void> {
      const { nodeUrl, serverUUID, apiToken, fetchTimeout } = context.options;
      const timeoutMs = Math.max(1, Number(fetchTimeout) || 8) * 1000;
      try {
        const response = await fetch(resourcesUrl(nodeUrl, serverUUID), {
          method: 'GET',
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiToken}`
          }
        });
        if (!response.ok) {
          const retryAfter = response.headers.get('Retry-After');
          context.logger.warn('Node API rejected the resource request', {
            status: response.status,
            ...(retryAfter ? { retryAfter } : {})
          });
          return;
        }
        const sample = parseResourcePayload(await response.json());
        if (context.signal.aborted) return;
        await models.usage.create({
          time: new Date(),
          server: serverID,
          match: await currentMatch(context, models.match, serverID),
          ...sample
        });
      } catch (error) {
        if (context.signal.aborted) return;
        context.logger.error('Resource sample failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      async mount(context) {
        validateOptions(context.options);
        const sequelize = context.connector('database');
        const models = defineModels(sequelize);
        await models.usage.sync();
        const serverID = context.options.overrideServerID ?? context.server.id;
        const sample = (): Promise<void> => poll(context, models, serverID);
        // The runtime serializes interval callbacks, so a slow poll never overlaps the next.
        context.track(sample());
        context.setInterval(sample, context.options.updateInterval * 1000);
        context.logger.info('Mounted', {
          event: 'psg_monitor_mounted',
          serverID,
          updateInterval: context.options.updateInterval
        });
      }
    };
  }
});
