# Migrating to SquadXO

SquadXO uses a TypeScript runtime with compatibility support for maintained legacy plugins. It is not a drop-in implementation of every historical SquadJS internal API. Keep your existing configuration and review the enabled plugin set before the first upgraded startup.

## Before replacing an installation

1. Back up the application, operational config and database; verify that you can restore them.
2. Extract the new archive into a separate directory. Use Node.js 24.x and install its locked dependencies with `npm ci --omit=dev`. Copy your working config rather than overwriting it with generated defaults. Keep local data and external plugin modules outside replaceable release files.
3. Review enabled plugins and connector aliases against the [generated reference](../reference/plugins.md). Missing modules, required options, connectors and native API mismatches fail startup. Disable plugins you have not configured; new native examples start disabled.
4. For a shared DBLog database, stop or disable other writers during the first structural adoption. Start one instance, wait for the schema-ready message, then restart the others. Follow the [database migration procedure](production.md#database-migration) for the exact sequence.

## Compatibility changes

EOS IDs are the canonical live identity. Steam IDs are optional compatibility metadata, so plugins must not assume that every player has one. Log events can also lack a resolvable participant; see [legacy compatibility](../contracts/legacy-plugin-compatibility.md).

### Database schema migration

**On first startup with DBLog enabled, SquadXO migrates an unversioned DBLog database before plugins mount.** SquadXO’s core DBLog creates or adopts schema version 1 before plugins mount. It records the version in `DBLog_Metadata`, makes `DBLog_Players.steamID` nullable where needed, and adds `attackerEOSID`/`victimEOSID` to combat tables plus `reviverEOSID` to revives. Existing `DBLog_*` names and Steam-valued participant columns keep their meaning; new events can identify players by EOS even when Steam metadata is unavailable. Review Steam-only joins and dashboards that would omit those participants.

Back up the database and use one writer for the first structural migration. Historical EOS backfill defaults to `off`: new writes include EOS IDs, while older combat rows need the separate resumable backfill to populate their EOS columns. Follow the [database migration procedure](production.md#database-migration) and [schema contract](../contracts/db-log-schema.md) before starting against existing data. Application rollback does not undo the schema changes; [database restoration](production.md#rollback) is a separate recovery decision because restoring a backup discards newer rows.

### Upstream plugin replacements

For installations using these plugins from [upstream SquadJS](https://github.com/Team-Silver-Sphere/SquadJS/tree/7c86ab71fee1427093672100af912af230d4fa5d/squad-server/plugins):

- Replace `DiscordAdminRequest` with `unnAdminRequest`, which creates a Discord request thread and relays messages until the request is closed. Review its options in the [plugin reference](../reference/plugins.md#unnadminrequest).
- Replace `DiscordRoundEnded` with native `discordRoundEnded`. Its configuration uses `type: "native"`, a module, named connectors and nested `options`, including `channelIDs` rather than a single `channelID`; see the [plugin reference](../reference/plugins.md#discordroundended).

Legacy entries retain their IDs and top-level options. Native entries use versioned definitions, connector aliases and nested options; module paths resolve relative to the config file. Disable a legacy handler before enabling a native replacement for the same notification or command. See the [native authoring contract](../contracts/native-plugin-authoring.md) for local and managed modules.

## Names and rollback

SquadXO is the product name. The npm self-reference `SquadJS/plugin-api`, `SQUADJS_*` environment variables, legacy plugin IDs and existing database identifiers remain unchanged for compatibility. Archive labels do not change the config schema or plugin API.

Retain the prior application and config until the upgraded instance is verified. Restore those application files for a normal rollback; database restoration is a separate recovery decision. See [Deployment](production.md#rollback).
