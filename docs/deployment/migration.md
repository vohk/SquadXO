# Migrating to SquadXO

SquadXO uses a TypeScript runtime with compatibility support for maintained legacy plugins. It is not a drop-in implementation of every historical SquadJS internal API. Keep your existing configuration and review the enabled plugin set before the first upgraded startup.

## Before replacing an installation

1. Back up the application, operational config and database; verify that you can restore them.
2. Extract the new archive into a separate directory. Use Node.js 24.x and install its locked dependencies with `npm ci --omit=dev`. Copy your working config rather than overwriting it with generated defaults. Keep local data and external plugin modules outside replaceable release files.
3. Review enabled plugins and connector aliases against the [generated reference](../reference/plugins.md). Missing modules, required options, connectors and native API mismatches fail startup. Disable plugins you have not configured; new native examples start disabled.
4. For a shared DBLog database, stop or disable other writers during the first structural adoption. Start one instance, wait for the schema-ready message, then restart the others. Follow the [database migration procedure](production.md#database-migration) for the exact sequence.

## Compatibility changes

EOS IDs are the canonical live identity. Steam IDs are optional compatibility metadata, so plugins must not assume that every player has one. Log events can also lack a resolvable participant; see [legacy compatibility](../contracts/legacy-plugin-compatibility.md).

DBLog keeps its `DBLog_*` table names and Steam columns for existing SQL consumers. Its additive, idempotent structural migration adds EOS support; it does not scan all historical event rows at startup. Historical EOS backfill defaults to `off` and is enabled separately. Review the [schema contract](../contracts/db-log-schema.md) and database backup/rollback instructions before changing a shared database. Do not restore an old database merely to roll back the application.

The old `ServerProfiler` alias is removed; select `unnServerProfiler` and preserve explicit options. Re-check chart/compression defaults if you relied on the alias's defaults. `DiscordIPDetection` is removed without a replacement. Plugins that call `restartRCON()` or `restartLogParser()` must migrate; the runtime owns those components and does not supply fake successful restart methods.

The public release removes `autoProfiler`, `ConsecutiveWinsRandomizer`, `DiscordAdminRequest`, legacy `DiscordRoundEnded` and `PersistentEOSIDtoSteamID`. Remove those entries from existing configs; use `SmartSwitch`, `unnAdminRequest` and native `discordRoundEnded` where needed. Enable DBLog for persistent EOS/Steam associations in `DBLog_Players`. Existing `EOS_SteamIDtoEOSIDs` tables and records are preserved but no longer updated by the public runtime; external SQL consumers must migrate.

Legacy entries retain their IDs and top-level options. Native entries use versioned definitions, connector aliases and nested options; module paths resolve relative to the config file. Disable a legacy handler before enabling a native replacement for the same notification or command. See the [native authoring contract](../contracts/native-plugin-authoring.md) for local and managed modules.

## Names and rollback

SquadXO is the product name. The npm self-reference `SquadJS/plugin-api`, `SQUADJS_*` environment variables, legacy plugin IDs and existing database identifiers remain unchanged for compatibility. Archive labels do not change the config schema or plugin API.

Retain the prior application and config until the upgraded instance is verified. Restore those application files for a normal rollback; database restoration is a separate recovery decision. See [Deployment](production.md#rollback).
