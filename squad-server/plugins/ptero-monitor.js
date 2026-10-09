import BasePlugin from './base-plugin.js';
import DBLog from './db-log.js';
import { DataTypes } from 'sequelize';


export default class PteroMonitor extends BasePlugin{
  static get description(){
    return "Monitor pterodactyl resource usage and save it to the db-log";
  }

  static get defaultEnabled(){
    return false;
  }

  static get optionsSpecification(){
    return {
      apiPrefix:
        {
          required: false,
          description: 'The API site url.',
          default: 'https://panel.example.com'
        },
      serverUUID:
        {
          required: true,
          description: 'The UUID of the server to pull stats from.',
          default: null
        },
      apiToken:
        {
          required: true,
          description: 'The API token.',
          default: null
        },
      updateInterval:
        {
          required: false,
          description: 'The update interval for the server to pull stats from (in seconds).',
          default: 10
        },
      fetchTimeout:
        {
          required: false,
          description: 'Maximum time to wait for the panel API before skipping this sample (in seconds).',
          default: 8
        }
    }
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.prepareToMount = (async () => {
      await this.prepareToMountCustom();
    }).bind(this);

    this.newProcInfo = this.newProcInfo.bind(this);

    this.DBLogPlugin;

    this.models = {};
    this.updateTimer = null;
    this.updateInFlight = null;
    this.abortController = null;
    this.stopping = false;
  }

  createModel(name, schema){
    if(!this.DBLogPlugin) return;
    this.models[name] = this.DBLogPlugin.options.database.define(`PM_${name}`, schema, {timestamps: false});
  }

  async prepareToMountCustom(){
    this.DBLogPlugin = this.server.plugins.find(p => p instanceof DBLog);
    if(!this.DBLogPlugin) return;

    await this.createModel('ServerUsage', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      time: {
        type: DataTypes.DATE
      },
      server: {
        type: DataTypes.INTEGER
      },
      match: {
        type: DataTypes.INTEGER
      },
      status: {
        type: DataTypes.INTEGER
      },
      memory: {
        type: DataTypes.BIGINT
      },
      cpu: {
        type: DataTypes.FLOAT
      },
      disk: {
        type: DataTypes.BIGINT
      }
    });

    await this.models.ServerUsage.sync();
  }

  async mount() {
    this.stopping = false;
    await this.newProcInfo();
    if (!this.stopping) {
      this.updateTimer = setInterval(this.newProcInfo, this.options.updateInterval * 1000);
    }
  }

  async unmount() {
    this.stopping = true;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    this.abortController?.abort();
    await this.updateInFlight;
  }

  normalizeStatus(status) {
    if (typeof status === 'number') return status;
    if (typeof status !== 'string') return 0;

    const statusMap = {
      offline: 0,
      stopping: 1,
      starting: 2,
      running: 3
    };

    return statusMap[status.toLowerCase()] ?? 0;
  }

  parseResourcePayload(json) {
    // Legacy payload shape
    const legacyMemory = json?.proc?.memory?.total;
    const legacyCPU = json?.proc?.cpu?.total;
    const legacyDisk = json?.proc?.disk?.used;

    // Current Wisp payload shape
    const currentMemory = json?.process?.memory_used;
    const currentCPU = json?.process?.cpu_used;
    const currentDisk = json?.process?.disk_used;

    return {
      status: this.normalizeStatus(json?.status),
      memory: legacyMemory ?? currentMemory ?? 0,
      cpu: legacyCPU ?? currentCPU ?? 0,
      disk: legacyDisk ?? currentDisk ?? 0
    };
  }

  async newProcInfo() {
    if (this.stopping || !this.DBLogPlugin || !this.models.ServerUsage) return;

    if (this.updateInFlight) {
      this.verbose(
        2,
        'Skipping Pterodactyl resource poll because the previous poll is still running'
      );
      return this.updateInFlight;
    }

    const operation = this.pollProcInfo();
    this.updateInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.updateInFlight === operation) this.updateInFlight = null;
    }
  }

  async pollProcInfo() {
    const abortController = new AbortController();
    this.abortController = abortController;
    const timeoutMs = Math.max(1, Number(this.options.fetchTimeout) || 8) * 1000;
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(
        `${this.options.apiPrefix}/api/client/servers/${this.options.serverUUID}/resources`,
        {
          method: "GET",
          signal: abortController.signal,
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/vnd.wisp.v1+json",
            "Authorization": `Bearer ${this.options.apiToken}`
          }
        }
      );
      if (!response.ok) {
        this.verbose(1, 'Error fetching resource stats from panel api');
      }

      const json = await response.json();
      this.verbose(2, JSON.stringify(json));
      const parsed = this.parseResourcePayload(json);
      if (this.stopping) return;

      await this.models.ServerUsage.create({
        time: new Date(),
        server: this.DBLogPlugin.options.overrideServerID || this.server.id,
        match: this.DBLogPlugin?.match?.id ?? null,
        status: parsed.status,
        memory: parsed.memory,
        cpu: parsed.cpu,
        disk: parsed.disk
      });

    } catch (error) {
      if (!this.stopping || error?.name !== 'AbortError') this.verbose(1, error);
    } finally {
      clearTimeout(timeout);
      if (this.abortController === abortController) this.abortController = null;
    }
  }
}
