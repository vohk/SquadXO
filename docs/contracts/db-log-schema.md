# Legacy DBLog contract

This is the dialect-neutral compatibility baseline derived from `squad-server/plugins/db-log.js`. Sequelize pluralizes the model names into the `DBLog_*` table names shown below. This contract records existing names and meanings; it does not authorize schema changes.

Unless noted otherwise, fields are nullable in the legacy models. The plugin uses a non-Sequelize `notNull` property in several declarations, so it does not establish `NOT NULL` constraints through those properties. The checked-in legacy definitions establish this baseline; deployed databases may have additional constraints or consumer-specific changes.

| Table                | Columns and logical types                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DBLog_Servers`      | `id` integer PK auto increment; `name` string                                                                                                                                                                                                                                        |
| `DBLog_Matches`      | `id` integer PK auto increment; `dlc`, `mapClassname`, `layerClassname`, `map`, `layer`, `winner`, `team1faction`, `team1unit`, `team2faction`, `team2unit` strings; `startTime`, `endTime` timestamps; `winnernum`, `team1tickets`, `team2tickets`, `server` integers               |
| `DBLog_TickRates`    | `id` integer PK auto increment; `time` timestamp; `tickRate` float; `server` required integer FK; `match` integer FK                                                                                                                                                                 |
| `DBLog_PlayerCounts` | `id` integer PK auto increment; `time` timestamp; `players`, `publicQueue`, `reserveQueue` integers; `server` required integer FK; `match` integer FK                                                                                                                                |
| `DBLog_SteamUsers`   | `steamID` string PK; `lastName` string                                                                                                                                                                                                                                               |
| `DBLog_Players`      | `id` integer PK auto increment; `eosID` unique string with an index; `steamID` unique string with an index; `lastName`, `lastIP` strings                                                                                                                                             |
| `DBLog_Wounds`       | `id` integer PK auto increment; `time` timestamp; `victim`, `attacker` Steam-valued string FKs; `victimName`, `attackerName`, `weapon` strings; `victimTeamID`, `victimSquadID`, `attackerTeamID`, `attackerSquadID`, `server`, `match` integers; `damage` float; `teamkill` boolean |
| `DBLog_Deaths`       | Wound columns plus `woundTime` timestamp                                                                                                                                                                                                                                             |
| `DBLog_Revives`      | Death columns plus `reviver` Steam-valued string FK, `reviverName` string, `reviverTeamID` and `reviverSquadID` integers                                                                                                                                                             |

## Relationship semantics

- `server` references `DBLog_Servers.id`; it is required on event/stat rows.
- `match` references `DBLog_Matches.id` and may be null outside an active match.
- `attacker`, `victim`, and `reviver` reference `DBLog_Players.steamID`. They contain Steam IDs, not EOS IDs. Existing direct consumers depend on that meaning.
- `DBLog_Players.eosID` and `steamID` remain unique. Current writes use EOS as the canonical identity while retaining the row that owns a supplied Steam ID, because legacy event relations reference that value. If the two identifiers are already split across rows, the writer moves the current EOS mapping to the Steam-owning row and clears the stale EOS mapping without deleting or rewriting either Steam identity's historical event relations.
- Model synchronization uses plain `Model.sync()` and there is no DBLog schema version table in the baseline.

SQLite identity reconciliation and legacy migration/query compatibility are exercised in `test/integration/db-log.test.ts`; SmartSwitch’s SQL consumers are implemented in `squad-server/plugins/smart-switch.js`. Validate additional external-consumer queries against the deployed schema.

## TypeScript schema version 1

The TypeScript runtime owns a DBLog-scoped `DBLog_Metadata` table whose `schemaVersion` entry is currently `1`. An unversioned database is adopted only after all expected legacy tables and core columns are present. A newer version or an incomplete versioned schema is rejected.

Version 1 keeps all legacy names and Steam-valued participant columns, makes `DBLog_Players.steamID` nullable, and adds nullable EOS columns:

- `DBLog_Wounds.attackerEOSID`, `victimEOSID`
- `DBLog_Deaths.attackerEOSID`, `victimEOSID`
- `DBLog_Revives.attackerEOSID`, `victimEOSID`, `reviverEOSID`

Structural migration records `schemaVersion=1` and a separate `eosBackfillV1` state in `DBLog_Metadata`. Legacy databases begin in `pending` state without updating historical event rows. Fresh empty databases and databases completed by the older all-at-once version-1 migrator are recorded as `complete`.

The explicit backfill scans stable primary-key ranges and fills EOS columns only where a legacy Steam participant maps to an existing `DBLog_Players.eosID`. Each batch and table transition is committed with its cursor, so shutdown and failure do not restart completed ranges. EOS indexes are created only after the data scan. PostgreSQL resolves each batch with set-based player joins; other dialects retain the portable correlated lookup. New writes require an EOS ID and reconcile players transactionally through EOS and any available Steam metadata. Events without Steam metadata do not clear an existing Steam mapping, and legacy Steam columns are populated only when that metadata is available.

The SQLite structural migration uses an explicit foreign-key-safe player-table rebuild because Sequelize's generic `changeColumn` rebuild can cascade-delete event rows. PostgreSQL background index creation is concurrent; MariaDB/MySQL background creation requires an online in-place operation and fails with an instruction to use blocking maintenance if the database cannot provide one.

## Match display metadata

Legacy DBLog writes resolve `DBLog_Matches.map` and `layer` from the layer catalog when a new match starts. `mapClassname` and `layerClassname` retain the corresponding raw identifiers. Direct SQL consumers may rely on `map` being populated whenever `mapClassname` is available.

An early TypeScript runtime regression passed `NEW_GAME` to DBLog before the compatibility layer attached its resolved layer. A round-winner field could consequently populate `layer` with stale data while `map` remained null. During DBLog initialization, the runtime groups affected rows by their preserved classnames and resolves the correct display values through the layer catalog. If a catalog entry is unavailable, it falls back to `mapClassname` and `layerClassname`. The update is conditional on `map` remaining null, so it is idempotent. This small match-table repair does not change schema version 1 or scan the much larger combat tables.

The repair makes historical matches queryable again, but it cannot rewind cursors maintained by an external subscriber. A subscriber that advanced past excluded match IDs must perform its own idempotent replay after the match rows have been repaired.
