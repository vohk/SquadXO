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

## SmartSwitch behavior

[SmartSwitch options](#smartswitch) control requests, queues and automatic balancing.

- Automatic shuffling and balancing keep parties together, even across squads. A party that cannot fit can leave a residual imbalance.
- An ordinary member's explicit request is individual. A leader's request includes the entire party and checks the projected team gap before moving anyone.
- Failed queues and partial shuffle destinations are retained. Overlapping queued players and squads are deduplicated; cooldowns are recorded only for observed moves.
- The queue table's nullable `targetTeamID` column is added by an idempotent migration. Queue destinations persist across retries and restarts; in-memory squad and shuffle plans last only for the plugin instance.

Whole-party moves use the roster's `isLeader` flag as the party-leader signal. See the [shared team-switch contract](../contracts/legacy-plugin-compatibility.md#party-aware-team-changes) for roster validation and command verification.

## Native plugins

Module paths below are for the compiled runtime. Option defaults come from each definition; connector aliases map to keys in your main config. No plugin is created or mounted during generation.

//NATIVE-PLUGIN-INFO//

## RCON recorder behavior

The native `rconRecorder` example is disabled. It records shared-client command outcomes and unsolicited pushed bodies while mounted; it sends no extra commands and excludes authentication packets. Its implementation was inspired by [lbzepoqo's RconRecorder](https://github.com/lbzepoqo/SquadJS/blob/0f686f8300270a8eb50b726d476a7c28771cd938/squad-server/plugins/rcon-recorder.js), with native subscriptions and new bounded storage. Original SquadJS copyright and Boost Software License notices are retained in source and `LICENSE`.

`directory`, `retentionDays` and `maxTotalMB` retain their upstream purpose. `recordLogLines` now defaults to false; enable it explicitly to include raw game-log content. The new file, queue, entry and deduplication bounds are listed in the options table. Limits use MiB/KiB (1024-based). Commands, responses and pushes may contain chat, player IDs/IPs, moderation details or operator-supplied secrets; protect the dedicated directory. New directories/files use modes 0700/0600 where supported. Existing directory permissions are not changed. Never share a directory between processes or recorder instances; overlapping instances in one process are rejected. Only filenames owned by this recorder are pruned, leaving unrelated files alone.

Each JSONL entry has `schemaVersion: 1`, `serverID`, `type` and a UTC `time`. Command records additionally carry request ID, request/send times, duration and success/error outcome. Authentication packets are never emitted, and occurrences of the configured RCON password in RCON audit text are redacted without changing the returned response. The opt-in raw game-log view also redacts the configured RCON password; other secrets in application/log content are not automatically identified. Oversized text is shortened with a `truncated` field naming the affected fields. Records larger than the configured serialized entry limit are dropped.

Successful repeated responses use `same: true` instead of `response`, keyed by the SHA-256 `commandKey` of the complete audited command. References are to the last written successful response for that key in the same file. The bounded cache resets per file; evicted entries are written in full again. A file with truncated responses is not a lossless replay of all original content.

Files rotate at UTC hour changes or `maxFileMB`; filenames include a unique suffix, so a backwards clock or repeated hour cannot reopen an older file. Completion timestamps choose the command's hour. One worker serializes writes, rotation, gzip and retention. `maxTotalMB` counts the active file and reserves compression scratch as well as archives. Oldest closed files are removed first, with age retention and a 1024-file ceiling. If gzip cannot fit alongside its source, JSONL is retained. Startup removes interrupted scratch files and compresses surviving JSONL when the budget permits. Maintenance also rotates idle hours and applies retention once a minute.

Slow disk does not block RCON: the queue is limited by serialized bytes and 4096 entries, and excess entries are dropped. A first overload warning, minute summaries and shutdown totals report drops, oversized entries and I/O failures without their content. Failed writes are rolled back where possible and later entries retry. Unmount unsubscribes, stops maintenance, drains accepted entries, closes the file and waits for compression; later callbacks cannot reopen files.
