# Native plugin authoring contract

SquadXO retains the `SquadJS/plugin-api` import for compatibility. Native plugins are ESM modules that export one versioned plugin definition. `definePlugin` from that API is a typing helper; the loader also accepts a definition object exported directly. Configuration explicitly selects the module, instance name, typed options, and named connector aliases. Unknown options or connectors, missing required values, API version mismatches, and module/name mismatches fail before RCON or log processing starts.

An optional definition `description` supplies one sentence for generated reference documentation. It does not change API version 1 or plugin lifecycle.

`SquadJS/plugin-api` is a package self-reference that resolves inside the SquadXO package tree. A module outside that tree must provide resolvable runtime dependencies or bundle them into its file; imports resolve from the module’s location, not from `config.json`. A self-contained definition object needs no runtime API import.

## Supported context

`PluginContext` exposes immutable options, declared Discord or Sequelize connectors, current server state snapshots, normalized Squad events, EOS-first RCON operations, scoped logging, lifecycle-owned timers and background tasks, an `AbortSignal`, and `context.server`, the instance identity taken from `config.server.id` and the optional `config.server.serverName`. Plugins must use these surfaces rather than parser sockets, RCON transports, other plugin instances, or mutable core state.

`RAW_LOG_LINE` is the typed high-frequency event for patterns that the normalized parser does not model. The runtime reads each line once and shares the same string with subscribers. Handlers must perform bounded synchronous classification and move network, filesystem, or other asynchronous work into `context.track()`. Prefer normalized events whenever the needed data is already represented.

`context.logs.copyCurrent(destination, { maximumBytes })` copies a bounded snapshot of the active `SquadGame.log`. Local mode opens the current file and copies only its initial size; SFTP mode uses an isolated authenticated connection and copies the initial remote byte range. The operation is cancelled automatically during plugin shutdown. It does not expose local paths or SFTP credentials. Callers own the destination and must remove it after use.

Event subscriptions, timers, and tracked tasks are released by the runtime. A plugin must remove listeners it installs directly on connector objects in `unmount()`. Long-running work should use `context.signal`, and directly registered callback promises should be passed to `context.track()` so errors are reported and shutdown waits for completion.

## Configuration shape

```json
{
  "type": "native",
  "name": "ExamplePlugin",
  "module": "./path/to/example-plugin.js",
  "enabled": true,
  "connectors": {
    "discord": "discord"
  },
  "options": {
    "message": "hello"
  }
}
```

Connector keys on the left are aliases declared by the plugin; values on the right select connector entries from the main configuration. SQL plugins should depend on Sequelize rather than a specific dialect so PostgreSQL, MariaDB/MySQL, and SQLite remain interchangeable where their queries permit.

## Managed GitHub source and updates

A native plugin may be loaded from one self-contained JavaScript file committed to GitHub instead of a local `module`. The configured repository, ref, and path are the operator's explicit trust decision:

```json
{
  "type": "native",
  "name": "ExamplePlugin",
  "source": {
    "provider": "github",
    "repository": "example-author/squadjs-example-plugin",
    "ref": "main",
    "path": "dist/plugin.js"
  },
  "updates": {
    "enabled": true,
    "intervalMinutes": 240,
    "apply": "hot"
  },
  "enabled": true,
  "connectors": {},
  "options": {}
}
```

`ref` defaults to `main`. Updates are disabled unless `updates.enabled` is explicitly true. Public repositories require no credentials; private repositories use `SQUADJS_GITHUB_TOKEN`. SquadXO identifies releases by Git blob revision, verifies downloaded content against that revision, records a local SHA-256, and caches immutable copies under `data/native-plugins/`.

`apply: "hot"` validates the new definition before stopping the current instance, releases its runtime-owned resources, mounts the replacement, and remounts the prior revision if mounting fails. The plugin receives a fresh instance, so state that must survive an update belongs in durable plugin storage. Adding a new required option or changing configured connector requirements rejects the update and leaves the current revision running.

`apply: "restart"` downloads and validates updates but activates them during the next normal process start. A staged revision is promoted only after startup succeeds; an interrupted or failed startup selects the previous revision on the following attempt.

Plugin authors do not need releases, tags, manifests, signatures, or CI. They must commit a single ESM file that contains all of the plugin's code. A local bundler such as esbuild may be used during development, but SquadXO never runs package installation, build scripts, or repository code other than the configured plugin module itself.
