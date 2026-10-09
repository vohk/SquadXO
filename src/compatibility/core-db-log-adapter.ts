import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Sequelize } from 'sequelize';
import type { RuntimePluginConfig } from '../config/runtime-config.js';
import type { DbLog } from '../database/db-log.js';

interface LegacyDbLogConstructor {
  readonly prototype: object;
}

export async function createCoreDbLogAdapter(
  dbLog: DbLog,
  sequelize: Sequelize,
  config: RuntimePluginConfig
): Promise<object> {
  const imported = (await import(
    pathToFileURL(resolve('squad-server/plugins/db-log.js')).href
  )) as { readonly default: LegacyDbLogConstructor };
  const adapter = Object.create(imported.default.prototype) as Record<string, unknown>;
  const model = (name: string): unknown => sequelize.models[`DBLog_${name}`];

  Object.defineProperties(adapter, {
    options: {
      enumerable: true,
      value: { ...config, database: sequelize }
    },
    models: {
      enumerable: true,
      value: {
        Server: model('Server'),
        Match: model('Match'),
        TickRate: model('TickRate'),
        PlayerCount: model('PlayerCount'),
        Player: model('Player'),
        Wound: model('Wound'),
        Death: model('Death'),
        Revive: model('Revive')
      }
    },
    match: {
      enumerable: true,
      get: () => (dbLog.currentMatchID === undefined ? null : { id: dbLog.currentMatchID })
    }
  });

  return adapter;
}
