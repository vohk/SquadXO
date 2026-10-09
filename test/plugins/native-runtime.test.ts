import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LegacyServerHost,
  type PluginFailure
} from '../../src/compatibility/legacy-server-facade.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { ServerState } from '../../src/domain/server-state.js';
import type { Plugin } from '../../src/plugins/api.js';
import { PluginRuntime } from '../../src/plugins/runtime.js';
import { SquadRconClient } from '../../src/rcon/client.js';

class FakeRcon extends SquadRconClient {
  constructor() {
    super({ host: '127.0.0.1', port: 1, password: 'unused', autoReconnect: false });
  }
}

function runtimeHarness() {
  const state = new ServerState();
  const rcon = new FakeRcon();
  const failures: PluginFailure[] = [];
  const events = new LegacyServerHost({ state, rcon });
  const database = { kind: 'test-database' };
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry({ primary: database }),
    onFailure: (failure) => failures.push(failure)
  });
  return { runtime, events, failures, database };
}

test('native runtime owns timers, tasks, connectors, subscriptions, and the RCON facade', async () => {
  const { runtime, events, failures, database } = runtimeHarness();
  let eventCalls = 0;
  let timerCalls = 0;
  let connector: unknown;
  let exposedRawExecute = false;
  let releaseTask: (() => void) | undefined;
  const backgroundTask = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const plugin: Plugin = {
    mount(context) {
      connector = context.connector('database');
      exposedRawExecute = 'execute' in context.rcon;
      context.on('TICK_RATE', () => {
        eventCalls += 1;
      });
      context.setInterval(() => {
        timerCalls += 1;
        throw new Error('timer failed');
      }, 1);
      context.track(backgroundTask);
    }
  };
  await runtime.mount('native-test', plugin, {}, { database: 'primary' });
  events.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 50 } });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 8));

  assert.equal(connector, database);
  assert.equal(exposedRawExecute, false);
  assert.equal(eventCalls, 1);
  assert.ok(timerCalls >= 1);
  assert.ok(failures.some((failure) => failure.event === 'interval callback'));

  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolveDelay) => setImmediate(resolveDelay));
  assert.equal(stopped, false);
  releaseTask?.();
  await stopping;
  const callsAfterStop = timerCalls;
  events.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 49 } });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
  assert.equal(eventCalls, 1);
  assert.equal(timerCalls, callsAfterStop);
});

test('native mount failure releases partial resources and calls unmount', async () => {
  const { runtime, events } = runtimeHarness();
  let eventCalls = 0;
  let unmounted = false;
  const plugin: Plugin = {
    mount(context) {
      context.on('TICK_RATE', () => {
        eventCalls += 1;
      });
      context.setTimeout(() => {
        eventCalls += 10;
      }, 1);
      throw new Error('mount failed');
    },
    unmount() {
      unmounted = true;
    }
  };

  await assert.rejects(runtime.mount('broken-native', plugin), /mount failed/);
  events.publish({ name: 'TICK_RATE', data: { time: new Date(), tickRate: 50 } });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
  assert.equal(unmounted, true);
  assert.equal(eventCalls, 0);
});

test('native plugins unmount in reverse order', async () => {
  const { runtime } = runtimeHarness();
  const order: string[] = [];
  await runtime.mount('first', { mount() {}, unmount: () => void order.push('first') });
  await runtime.mount('second', { mount() {}, unmount: () => void order.push('second') });
  await runtime.stop();
  assert.deepEqual(order, ['second', 'first']);
});

test('native plugin replacement is not blocked forever by an abandoned task', async () => {
  const state = new ServerState();
  const rcon = new FakeRcon();
  const events = new LegacyServerHost({ state, rcon });
  const runtime = new PluginRuntime({
    state,
    rcon,
    events,
    connectors: new ConnectorRegistry(),
    shutdownTimeoutMs: 10
  });
  await runtime.mount('abandoned', {
    mount(context) {
      context.track(new Promise(() => undefined));
    }
  });

  await assert.rejects(
    runtime.unmount('abandoned'),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (entry) => entry instanceof Error && /did not stop within 10ms/.test(entry.message)
      )
  );
  await runtime.mount('replacement', { mount() {} });
  await runtime.stop();
});
