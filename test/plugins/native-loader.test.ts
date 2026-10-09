import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RuntimeNativePluginConfig } from '../../src/config/runtime-config.js';
import { createNativePluginPlan } from '../../src/plugins/loader.js';

test('discovers and validates a native ESM plugin without creating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-native-plugin-'));
  const modulePath = join(directory, 'plugin.mjs');
  try {
    await writeFile(
      modulePath,
      `globalThis.__nativePluginCreated = 0;
export default {
  apiVersion: 1,
  name: 'Example',
  options: { greeting: { type: 'string', default: 'hello' }, enabled: { type: 'boolean', required: true } },
  connectors: { database: { type: 'sequelize' } },
  create() { globalThis.__nativePluginCreated += 1; return { mount() {} }; }
};`
    );
    const config: RuntimeNativePluginConfig = {
      type: 'native',
      name: 'Example',
      module: './plugin.mjs',
      modulePath,
      enabled: true,
      options: { enabled: true },
      connectors: { database: 'primary' }
    };
    const plan = await createNativePluginPlan([config]);

    assert.deepEqual(plan.plugins[0]?.options, { greeting: 'hello', enabled: true });
    assert.deepEqual(plan.plugins[0]?.connectors, { database: 'primary' });
    assert.deepEqual(plan.connectors, [{ name: 'primary', type: 'sequelize', plugin: 'Example' }]);
    assert.equal((globalThis as Record<string, unknown>).__nativePluginCreated, 0);

    await assert.rejects(
      createNativePluginPlan([{ ...config, options: { enabled: true, extra: 1 } }]),
      /unknown option extra/
    );
    await assert.rejects(
      createNativePluginPlan([{ ...config, connectors: {} }]),
      /connector database is required/
    );
  } finally {
    delete (globalThis as Record<string, unknown>).__nativePluginCreated;
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unsupported native API versions and mismatched names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squadjs-native-plugin-'));
  try {
    const modulePath = join(directory, 'plugin.mjs');
    await writeFile(
      modulePath,
      `export default { apiVersion: 2, name: 'Other', options: {}, connectors: {}, create() { return { mount() {} }; } };`
    );
    const config: RuntimeNativePluginConfig = {
      type: 'native',
      name: 'Example',
      module: './plugin.mjs',
      modulePath,
      enabled: true,
      options: {},
      connectors: {}
    };
    await assert.rejects(createNativePluginPlan([config]), /unsupported API version 2/);

    const mismatchedPath = join(directory, 'mismatched.mjs');
    await writeFile(
      mismatchedPath,
      `export default { apiVersion: 1, name: 'Other', options: {}, connectors: {}, create() { return { mount() {} }; } };`
    );
    await assert.rejects(
      createNativePluginPlan([{ ...config, modulePath: mismatchedPath }]),
      /module declares the name Other/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
