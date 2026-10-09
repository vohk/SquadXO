# SquadXO deployment

## Release artifact

The production archive contains the compiled Node.js 24 runtime, maintained plugins, dependency lockfile, example config, operator docs and checksums. Install dependencies separately; operational configs, data, TypeScript source and development tools are not included.

From a clean source checkout:

```sh
npm ci
npm run lint
npm test
npm run package:production -- --version v1.0.1
```

This writes `artifacts/squadxo-v1.0.1.tar.gz` and its `.sha256` file. Packaging rebuilds the runtime and checks that config, README and plugin reference match their generators.

Regenerate and commit changed source artifacts before packaging: a Git checkout must be clean and have a commit.

`BUILD_INFO.json` records the version and source revision; a source tree without `.git` records a null revision for local validation only.

The [build workflow](../../.github/workflows/build.yml) validates and retains archives on manual runs. In `vohk/SquadXO`, pushing a `v*` tag that matches `package.json` also publishes the validated archive and checksum as a GitHub release; prerelease versions are marked as prereleases. Other repositories do not publish releases through this workflow. Deployment remains a separate action.

## Install and start

Use Node.js 24.x. A production archive is already compiled; build and generation commands apply only to source checkouts.

1. Verify the archive next to its checksum file: `sha256sum --check squadxo-v1.0.1.tar.gz.sha256`. Use the filenames for your downloaded version.
2. Extract into an empty directory with `tar -xzf squadxo-v1.0.1.tar.gz`, then `cd squadxo`.
3. Copy your existing `config.json` into that root. For a first installation, copy `config.example.json` to `config.json` and configure it before starting.
4. Install locked production dependencies and start from that root:

```sh
npm ci --omit=dev
node --unhandled-rejections=warn index.js
```

Keep production `config.json` beside `index.js` and run startup commands from that application root. Native and external legacy module paths resolve relative to `config.json`; relative log and SQLite paths resolve from the process working directory.

Configure the server connection:

- Set `server.id`, RCON host/port/password and log access for the target server.
- In `tail`/`local` mode, `server.logDir` is the directory containing `SquadGame.log`, not the file itself; the process needs permission to read it.
- For separate hosts, configure `sftp` and `server.sftp`.
- RCON and SFTP passwords may come from `SQUADJS_RCON_PASSWORD` and `SQUADJS_SFTP_PASSWORD`.

Review enabled plugins. Legacy defaults include enabled administration and Discord plugins; the example requires configuration before use.

- Fill required options, Discord bot token and target channels, or disable entries you do not intend to use.
- Discord tokens may come from `SQUADJS_DISCORD_TOKEN`. Configure the bot’s Message Content and Server Members intents in Discord’s developer portal to match the runtime.
- Missing required options, unavailable connectors or invalid native definitions can stop startup.

The example enables config key reordering and plugin sorting at startup; set `configManagement.reorderOnStartup` to `false` if a configuration-management system owns the file’s layout.

## Database migration

DBLog is optional and disabled in the example. When enabled, initialization creates or adopts its schema before plugins mount.

The version-1 migration preserves `DBLog_*` names and Steam-valued columns, adds nullable EOS fields and repairs incomplete match display metadata. New writes record EOS IDs even while historical backfill is disabled. See the [DBLog schema contract](../contracts/db-log-schema.md) for exact columns, identity reconciliation and repair behavior.

For an existing shared database:

1. Create and verify a restorable backup.
2. Stop or disable other writers for the first structural adoption so one instance applies it.
3. Start that instance and confirm the schema-ready message before restarting other writers.

```text
[DBLog] Legacy database schema detected; migration to version 1 in progress...
[DBLog] Database schema ready at version 1.
[DBLog] Historical EOS backfill is disabled; new records will still include EOS IDs.
```

### Optional historical EOS backfill

DBLog’s `eosBackfill` defaults to `off`:

```json
"eosBackfill": {
  "mode": "off",
  "batchSize": 5000,
  "pauseMs": 500,
  "runForMinutes": 0
}
```

- `off` leaves historical event rows unchanged.
- `background` starts normally and processes resumable batches. PostgreSQL uses concurrent index creation; MariaDB/MySQL requires supported online index creation.
- `blocking` finishes before plugins mount and permits blocking index creation. Use a maintenance window.
- `batchSize` sets rows’ primary-key range per transaction; `pauseMs` delays between batches. `runForMinutes: 0` runs until completion or shutdown; a positive value pauses after that duration.

Select one instance to run backfill. Progress is checkpointed in `DBLog_Metadata`; shutdown or failure can resume from the committed cursor. A database lease prevents concurrent backfill workers.

To run the worker separately from the game-connected runtime:

```sh
node dist/src/database/eos-backfill-cli.js --config config.json --mode background \
  --batch-size 5000 --pause-ms 500 --run-for-minutes 0
```

It selects the enabled DBLog connector unless `--connector <name>` is supplied. `SIGINT`/`SIGTERM` pauses after the current statement and committed cursor. Legacy Steam-based consumers remain compatible.

## Rollback

Retain the prior application and config until the new release is verified. Stop the new process, restore the previous application/config/startup command, restart and verify RCON, logs and plugin output.

The version-1 database migration is additive. Do not restore a database merely to roll back the application: that would discard new rows. Restore it only for a confirmed migration failure or corruption under a separate recovery decision.

## Configuration and connectors

The example uses the persistent local SQLite file `database.sqlite`. SQLite is a lightweight single-instance option; PostgreSQL, MariaDB or MySQL is preferred for production, shared databases and multiple writers.

Enable DBLog when you need its history, and select the same connector alias in consumers such as SmartSwitch. AltChecker and PteroMonitor use DBLog’s connector automatically. PlayerStateTracker and DiscordServerStatus’s message store can use separate connectors when they do not need that shared history.

There is no automatic fallback from a failed database.

See [Database connectors](../contracts/database-connectors.md) for examples and [Configuration and plugin reference](../reference/plugins.md) for plugin options.

Add local/native modules following the [Native plugin contract](../contracts/native-plugin-authoring.md) or [Legacy external-module contract](../contracts/legacy-plugin-compatibility.md#external-modules).
