import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Logger from 'core/logger';
import path from 'path';

class Plugins {
  constructor() {
    this.plugins = null;
    this.selection = null;
  }

  async getPlugins(force = false, files) {
    const selection = files ? JSON.stringify([...files].sort()) : 'directory';
    if (this.plugins && !force && this.selection === selection) return this.plugins;

    const plugins = {};

    const infrastructure = new Set([
      'index.js',
      'base-plugin.js',
      'discord-base-message-updater.js',
      'discord-base-plugin.js'
    ]);
    const pluginFilenames = (
      files ?? (await fs.readdir(path.dirname(fileURLToPath(import.meta.url))))
    )
      .map((filename) => path.basename(filename))
      .filter((filename) => filename.endsWith('.js') && !infrastructure.has(filename));

    for (const pluginFilename of pluginFilenames.sort((left, right) => left.localeCompare(right))) {
      Logger.verbose('Plugins', 1, `Loading plugin file ${pluginFilename}...`);
      const { default: Plugin } = await import(`./${pluginFilename}`);
      plugins[Plugin.name] = Plugin;
    }

    this.plugins = plugins;
    this.selection = selection;
    return plugins;
  }
}

export default new Plugins();
