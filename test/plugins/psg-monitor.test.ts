import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Sequelize } from 'sequelize';
import { LegacyServerHost } from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import psgMonitor, {
  normalizeStatus,
  parseResourcePayload,
  resourcesUrl
} from '../../src/plugins/builtin/psg-monitor.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';

class FakeRcon extends SquadRconClient {
  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }
}

test('maps node resource payloads and states', () => {
  assert.deepEqual(
    parseResourcePayload({
      is_suspended: false,
      state: 'Running',
      resources: { cpu_absolute: 12.5, disk_bytes: 300, memory_bytes: 400, uptime: 5 }
    }),
    { status: 3, memory: 400, cpu: 12.5, disk: 300 }
  );
  assert.deepEqual(parseResourcePayload(null), { status: 0, memory: 0, cpu: 0, disk: 0 });
  assert.equal(normalizeStatus('stopping'), 1);
  assert.equal(normalizeStatus('starting'), 2);
  assert.equal(normalizeStatus('bogus'), 0);
  assert.equal(
    resourcesUrl('https://node.example:8080/', 'abc-123'),
    'https://node.example:8080/api/user/servers/abc-123/resources'
  );
});

test('polls the node API and stores a sample tagged with the open match', async () => {
  const requests: IncomingMessage[] = [];
  const api = createServer((request, response) => {
    requests.push(request);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        is_suspended: false,
        state: 'running',
        resources: { cpu_absolute: 50, disk_bytes: 2000, memory_bytes: 1000 }
      })
    );
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const state = new ServerState();
  const rcon = new FakeRcon();
  const events = new LegacyServerHost({ state, rcon });
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry({ db: sequelize }),
    server: { id: 7 }
  });
  try {
    await sequelize.query(
      'CREATE TABLE "DBLog_Matches" ("id" INTEGER PRIMARY KEY, "server" INTEGER, "startTime" DATETIME, "endTime" DATETIME)'
    );
    await sequelize.query(
      'INSERT INTO "DBLog_Matches" ("id","server","endTime") VALUES (1,7,\'2026-01-01\'),(2,7,NULL),(3,8,NULL)'
    );
    const port = (api.address() as AddressInfo).port;
    await runtime.mount(
      'psgMonitor',
      psgMonitor.create(),
      {
        nodeUrl: `http://127.0.0.1:${port}`,
        serverUUID: 'uuid-1',
        apiToken: 'secret',
        updateInterval: 60,
        fetchTimeout: 2
      },
      { database: 'db' }
    );
    const deadline = Date.now() + 2000;
    let rows: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      [rows] = (await sequelize.query('SELECT * FROM "PM_ServerUsages"')) as [
        Record<string, unknown>[],
        unknown
      ];
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0], id: undefined, time: undefined },
      {
        id: undefined,
        time: undefined,
        server: 7,
        match: 2,
        status: 3,
        memory: 1000,
        cpu: 50,
        disk: 2000
      }
    );
    assert.equal(requests[0]?.url, '/api/user/servers/uuid-1/resources');
    assert.equal(requests[0]?.headers.authorization, 'Bearer secret');
  } finally {
    await runtime.stop();
    await sequelize.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

test('rejects an invalid node URL before polling', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const state = new ServerState();
  const rcon = new FakeRcon();
  const runtime = new PluginRuntime({
    state,
    rcon,
    events: new LegacyServerHost({ state, rcon }),
    connectors: new ConnectorRegistry({ db: sequelize })
  });
  try {
    await assert.rejects(
      runtime.mount(
        'psgMonitor',
        psgMonitor.create(),
        {
          nodeUrl: 'node.example',
          serverUUID: 'u',
          apiToken: 't',
          updateInterval: 10,
          fetchTimeout: 8
        },
        { database: 'db' }
      ),
      /nodeUrl/
    );
  } finally {
    await runtime.stop();
    await sequelize.close();
  }
});
