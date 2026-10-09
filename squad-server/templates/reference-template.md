# SquadXO configuration and plugin reference

Generated from the config template and plugin definitions. Run `npm run build-all` after changing plugin metadata. [Default configuration](../../config.example.json) · [Migration](../deployment/migration.md) · [Deployment](../deployment/production.md).

## Configuration

| Section | Purpose |
| --- | --- |
| `server` | Instance ID, RCON connection, log reader and optional admin lists. |
| `layers` | Optional named layer-catalog URLs; configuring this replaces the built-in source list. |
| `connectors` | Named Discord and Sequelize connections selected by plugins. |
| `plugins` | Enabled legacy or native entries and their options. |
| `configManagement` | Optional startup formatting and plugin sorting. |

For production, keep `config.json` beside `index.js` and start from the application root. Tests may select another file with `--config`; local module paths resolve relative to the selected config file. Use local `tail`/`local` log reading when possible, or `sftp` with `server.sftp` for a separate host. `SQUADJS_RCON_PASSWORD` and `SQUADJS_SFTP_PASSWORD` retain their existing names. Keep populated configs and tokens out of Git. Connector keys are aliases, not dialects; see [Database connectors](../contracts/database-connectors.md).

Legacy entries use `plugin`, `enabled` and top-level options. Native entries use `type: "native"`, `name`, `module` (or a managed GitHub `source`), `enabled`, connector aliases and nested `options`. New native examples are disabled until configured. Required placeholders must be filled in; review legacy enabled defaults before using the generated config. Do not enable two plugins for the same notification or command. Native built-ins are documented below; external modules use the same [versioned API](../contracts/native-plugin-authoring.md).

## Legacy plugins

`DBLog` is handled by the TypeScript core; its entry and schema remain compatible with legacy consumers. See the [DBLog schema contract](../contracts/db-log-schema.md). The tables below describe configuration metadata, not a promise that arbitrary historical plugin internals are supported. Tables show plugin-declared defaults; the generated default configuration applies template overrides, including the shared SQLite connector. Use that configuration as the starting example.

//LEGACY-PLUGIN-INFO//

## Native plugins

Module paths below are for the compiled runtime. Option defaults come from each definition; connector aliases map to keys in your main config. No plugin is created or mounted during generation.

//NATIVE-PLUGIN-INFO//
