# Plugin development

New plugins should use the versioned native API. Existing SquadJS plugins can continue using the legacy class format and their existing configuration; the compatibility facade remains available while plugins migrate.

## Native plugin module

Native plugins are ESM modules. Import the supported contract from `SquadJS/plugin-api` and export a definition whose name and API version match the configuration:

```js
import { definePlugin } from 'SquadJS/plugin-api';

export default definePlugin({
  apiVersion: 1,
  name: 'MyPlugin',
  options: {
    response: { type: 'string', default: 'Hello from MyPlugin' }
  },
  connectors: {
    database: { type: 'sequelize' }
  },
  create() {
    return {
      mount(context) {
        const database = context.connector('database');
        context.on('CHAT_COMMAND:hello', async ({ player }) => {
          if (player) await context.rcon.warn(player.eosID, context.options.response);
        });
        context.setInterval(() => context.logger.debug('Still running'), 60_000);
        context.logger.info('Mounted', { dialect: database.getDialect() });
      }
    };
  }
});
```

The repository includes a complete example at [`examples/native-admin-ping.mjs`](../../examples/native-admin-ping.mjs).

The `SquadJS/plugin-api` import resolves inside the installation’s package tree. For an external module, bundle or supply its runtime imports; alternatively export the definition object directly without the `definePlugin` typing helper. Package dependencies resolve from the module’s location.

## Configuration and discovery

Native entries are explicitly distinguished from unchanged legacy entries:

```json
{
  "type": "native",
  "name": "MyPlugin",
  "module": "./plugins/my-plugin.mjs",
  "enabled": true,
  "options": {
    "response": "Hello"
  },
  "connectors": {
    "database": "primary"
  }
}
```

The built-in `discordRoundEnded` native plugin is the multi-channel replacement for the legacy `DiscordRoundEnded` entry. It uses a declared Discord connector and accepts a `channelIDs` string array. Older configurations must replace the legacy entry with this native definition.

`module` is resolved relative to `config.json`. The configured `name` must match the module's definition. Unknown options/connectors, missing required values, incompatible connector types, and unsupported API versions are fatal startup errors. Module discovery and validation happen before SquadXO opens RCON or connector network connections.

Option declarations support `string`, `number`, `boolean`, `string[]`, and `object`. Connector declarations support `discord` and `sequelize`. A connector alias such as `database` is local to the plugin; the operator maps it to a named connector such as `primary`, so the plugin is independent of PostgreSQL, MariaDB/MySQL, or SQLite configuration.

## Runtime libraries

SquadXO installs `sharp` as a production dependency for image rendering. A plugin deployed inside the SquadXO installation may use it directly, for example:

```js
import sharp from 'sharp';

const png = await sharp(svgBuffer).png().toBuffer();
```

`sharp` is an available application library, not part of the versioned `PluginContext` API. A plugin distributed as its own package should still declare `sharp` as a direct dependency so its requirements and supported version remain explicit. Plugins must not install dependencies or modify the running application at runtime. Do not assume that other transitive packages in the SquadJS lockfile are supported plugin imports.

## Supported context

- `context.on(event, handler)` subscribes to typed, EOS-first events and returns an optional early unsubscribe function. `RAW_LOG_LINE` exposes each log line for bounded classification when no normalized event exists; prefer normalized events and never perform blocking I/O in this handler.
- `context.snapshot()` returns a copy of current players, squads, layers, and server information.
- `context.connector(alias)` returns a required connector declared by the plugin; `context.optionalConnector(alias)` returns an optional declaration or `undefined`.
- `context.rcon` exposes supported Squad operations (`listPlayers`, `listSquads`, map/server reads, broadcast, warn, kick, ban, and force-team-change). It does not expose sockets, command queues, or raw mutable RCON internals. Runtime audit policy can reject mutating operations.
- `context.logger` is scoped to the plugin.
- `context.signal` aborts when mount fails or shutdown begins.
- `context.setTimeout`, `context.setInterval`, and `context.track` register owned work.

Event and timer callback failures are reported against the plugin without stopping healthy core processing. A configured plugin that cannot import, validate, create, or mount is a fatal startup error. SquadXO cancels owned timers/subscriptions, aborts the signal, drains tracked work, and then unmounts plugins in reverse order. `unmount()` remains responsible for resources the plugin created directly, such as a server or file handle.

## Legacy compatibility

The supported boundary is recorded in [`docs/contracts/legacy-plugin-compatibility.md`](../../docs/contracts/legacy-plugin-compatibility.md).

Before legacy plugins mount, the runtime populates players, squads, current and next layers, and server information from RCON so their startup reads match the pre-rewrite lifecycle. Every configured legacy plugin instance is present in `server.plugins` before prepare or mount hooks run. Legacy player objects include their current squad object when one can be resolved. Before delivering `SQUAD_CREATED` to legacy plugins, the compatibility runtime refreshes the authoritative RCON player list and attaches the creator with current team and squad IDs. Player connection, possession, deployable-damage, moderation, and chat events likewise preserve the resolved-player payload expected by the pre-rewrite plugins. Manual player/squad refreshes use the same state and change-event path as scheduled refreshes. Legacy broadcasts that encounter a transient RCON disconnect wait up to five seconds for recovery and retry once; moderation and arbitrary RCON commands are never replayed automatically. Legacy callback and event-bridge failures are logged with their plugin or runtime scope.

The legacy `server.restartRCON()` and `server.restartLogParser()` functions are deprecated and explicitly unsupported by the compatibility facade. The runtime owns those components and performs automatic RCON recovery, log replacement handling, and SFTP reconnection. Restart the complete service when manual recovery is genuinely required; plugins must not claim that an unsupported subsystem restart succeeded.

Legacy plugins that depend on unsupported internals may be removed rather than emulated. Their historical source remains available through this repository's Git history and, where applicable, the upstream SquadJS repository.

## Migrating a legacy plugin

1. Replace the legacy class metadata with `definePlugin`, moving options and connector requirements into the declarations.
2. Replace `server.on(...)` with `context.on(...)` and use EOS IDs from event players.
3. Replace reads from mutable `server.players`, layers, or server fields with `context.snapshot()`.
4. Replace connector-name lookups and searches through `server.plugins` with declared connector aliases.
5. Replace raw `server.rcon.execute(...)` and internal socket access with supported `context.rcon` operations. Request a core API addition if a legitimate operation is missing.
6. Replace global timers and fire-and-forget promises with the owned timer and task helpers.

Legacy entries remain in their original shape, for example `{ "plugin": "ChatCommands", "enabled": true, ... }`. Native and legacy plugins can be enabled in the same installation and receive the same core event stream.

## Party-aware team changes

SmartSwitch and TeamRandomizer keep each party together during automatic shuffling and balancing, including party ID zero and parties spanning squads. Under the current server assumption, the single `Is Leader` member is also the party leader; that leader is commanded first. Missing or multiple leaders stop a whole-party move with an explicit error. An ordinary member's explicit SmartSwitch request remains individual; a leader request includes the entire party and checks its projected team gap before moving anyone. Parties can leave a residual imbalance when no whole party fits.

Switchers refresh the roster and verify the destination after each command. A server-moved party member already at its destination is skipped. Empty, malformed, duplicate, or incomplete rosters stop the operation; an unconfirmed command is not automatically retried. SmartSwitch retains failed queues and partial shuffle destinations, deduplicates overlapping queued players and squads, and records cooldowns only for observed moves. Its queue table gains a nullable `targetTeamID` through an additive, idempotent migration. Queue destinations survive retries; in-memory squad/shuffle plans survive only while the plugin instance runs.

Keep local plugins disabled during parser capture and offline verification. These changes have not been validated by performing production team changes; review the deployed server's leader behavior before enabling the switchers there.

Configuration metadata for both systems is generated into [the plugin reference](../../docs/reference/plugins.md). `npm run build-all` rebuilds and regenerates the default config, README and reference after metadata changes. `npm run build-reference` rebuilds and regenerates only the reference. Built-in native definitions supply their typed options and connector aliases; new native examples remain disabled until configured. Metadata generation reads the built-in definitions without creating or mounting plugin instances.
