import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin } from '../../src/plugins/api.js';

const definition = definePlugin({
  apiVersion: 1,
  name: 'TypedExample',
  options: {
    response: { type: 'string', default: 'hello' },
    note: { type: 'string', required: false }
  },
  connectors: {
    database: { type: 'sequelize' },
    discord: { type: 'discord', required: false }
  },
  create() {
    return {
      mount(context) {
        const response: string = context.options.response;
        const note: string | undefined = context.options.note;
        const database = context.connector('database');
        const discord = context.optionalConnector('discord');
        context.logger.debug(response, { note, dialect: database.getDialect(), discord });
      }
    };
  }
});

test('definePlugin retains option and connector declaration types', () => {
  assert.equal(definition.apiVersion, 1);
  assert.equal(definition.name, 'TypedExample');
});
