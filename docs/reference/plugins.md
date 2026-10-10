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

### AltChecker

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `commandPrefix` | no | — | `!altcheck` | Command name to get message. |
| `channelID` | yes | — | `` | The ID of the channel to log data. |
| `kickIfAltDetected` | no | — | `false` | Will kick a player if an ALT has been detected on his IP. |
| `onlyKickOnlineAlt` | no | — | `true` | Checks if a player with the same IP is already connected to server and kicks the player that is trying to connect |
| `kickReason` | no | — | `ALT detected. Protection kick` | Reason of the kick due to an ALT account being detected |

### AutoKickUnassigned

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `warningMessage` | no | — | `Join a squad, you are unassigned and will be kicked` | Message SquadJS will send to players warning them they will be kicked |
| `kickMessage` | no | — | `Unassigned - automatically removed` | Message to send to players when they are kicked |
| `frequencyOfWarnings` | no | — | `30` | How often in <b>Seconds</b> should we warn the player about being unassigned? |
| `unassignedTimer` | no | — | `360` | How long in <b>Seconds</b> to wait before a unassigned player is kicked |
| `playerThreshold` | no | — | `93` | Player count required for AutoKick to start kicking players, set to -1 to disable |
| `roundStartDelay` | no | — | `900` | Time delay in <b>Seconds</b> from start of the round before AutoKick starts kicking again |
| `ignoreAdmins` | no | — | `false` | <ul><li><code>true</code>: Admins will <b>NOT</b> be kicked</li><li><code>false</code>: Admins <b>WILL</b> be kicked</li></ul> |
| `ignoreWhitelist` | no | — | `false` | <ul><li><code>true</code>: Reserve slot players will <b>NOT</b> be kicked</li><li><code>false</code>: Reserve slot players <b>WILL</b> be kicked</li></ul> |

### AutoTKWarn

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `attackerMessage` | no | — | `Please apologise for ALL TKs in ALL chat!` | The message to warn attacking players with. |
| `victimMessage` | no | — | `null` | The message that will be sent to the victim. |

### CBLInfo

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to alert admins through. |
| `threshold` | no | — | `6` | Admins will be alerted when a player has this or more reputation points. For more information on reputation points, see the <a href="https://communitybanlist.com/faq">Community Ban List's FAQ</a> |

### ChatCommands

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `commands` | no | — | `[{"command":"squadjs","type":"warn","response":"This server is powered by SquadJS.","ignoreChats":[]}]` | An array of objects containing the following properties: <ul><li><code>command</code> - The command that initiates the message.</li><li><code>type</code> - Either <code>warn</code> or <code>broadcast</code>.</li><li><code>response</code> - The message to respond with.</li><li><code>ignoreChats</code> - A list of chats to ignore the commands in. Use this to limit it to admins.</li></ul> |

### DBLog

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `database` | yes | `sequelize` | `mysql` | The Sequelize connector to log server information to. |
| `overrideServerID` | no | — | `null` | A overridden server ID. |
| `eosBackfill` | no | — | `{"mode":"off","batchSize":5000,"pauseMs":500,"runForMinutes":0}` | Controls the optional historical EOS ID backfill. Leave mode off for fast startup, use background for throttled online work, or blocking during maintenance. |

### DiscordAdminBroadcast

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log admin broadcasts to. |
| `color` | no | — | `16761867` | The color of the embed. |

### DiscordAdminCamLogs

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log admin camera usage to. |
| `color` | no | — | `16761867` | The color of the embed. |

### DiscordChat

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log admin broadcasts to. |
| `chatColors` | no | — | `{}` | The color of the embed for each chat. |
| `color` | no | — | `16761867` | The color of the embed. |
| `ignoreChats` | no | — | `["ChatSquad"]` | A list of chat names to ignore. |

### DiscordChatRaw

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel used for raw chat logs. |
| `ignoreChats` | no | — | `["ChatSquad"]` | A list of chat names to ignore. |

### DiscordDebug

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log events to. |
| `events` | yes | — | `[]` | A list of events to dump. |

### DiscordFOBHABExplosionDamage

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log FOB/HAB explosion damage to. |
| `color` | no | — | `16761867` | The color of the embeds. |

### DiscordKillFeed

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log teamkills to. |
| `color` | no | — | `16761867` | The color of the embeds. |
| `disableCBL` | no | — | `false` | Disable Community Ban List information. |

### DiscordPlaceholder

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `command` | no | — | `!placeholder` | Command to create Discord placeholder. |
| `channelID` | yes | — | `` | The bot will only answer with a placeholder on this channel |

### DiscordRcon

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | ID of channel to turn into RCON console. |
| `permissions` | no | — | `{}` | <ul><li>Dictionary of roles and a list of the permissions they are allowed to use.<li>If dictionary is empty (<code>{}</code>) permissions will be disabled</li><li>A list of available RCON commands can be found here <a>https://squad.gamepedia.com/Server_Administration#Admin_Console_Commands</a>.</ul> |
| `prependAdminNameInBroadcast` | no | — | `false` | Prepend admin names when making announcements. |

### DiscordRoundWinner

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log admin broadcasts to. |
| `color` | no | — | `16761867` | The color of the embed. |

### DiscordServerStatus

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `messageStore` | yes | `sequelize` | `sqlite` | Sequelize connector name. |
| `command` | no | — | `!status` | Command name to get message. |
| `disableSubscriptions` | no | — | `false` | Whether to allow messages to be subscribed to automatic updates. |
| `updateInterval` | no | — | `60000` | How frequently to update the time in Discord. |
| `setBotStatus` | no | — | `true` | Whether to update the bot's status with server information. |

### DiscordSquadCreated

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log Squad Creation events to. |
| `color` | no | — | `16761867` | The color of the embed. |
| `useEmbed` | no | — | `true` | Send message as Embed |

### DiscordTeamkill

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log teamkills to. |
| `color` | no | — | `16761867` | The color of the embeds. |
| `disableCBL` | no | — | `false` | Disable Community Ban List information. |

### FogOfWar

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `mode` | no | — | `1` | Fog of war mode to set. |
| `delay` | no | — | `10000` | Delay before setting fog of war mode. |

### IntervalledBroadcasts

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `broadcasts` | no | — | `[]` | Messages to broadcast. |
| `interval` | no | — | `300000` | Frequency of the broadcasts in milliseconds. |

### PlayerStateTracker

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `database` | no | `sequelize` | `null` | Sequelize connector name. If omitted, the DBLog connector is used temporarily for backward compatibility. |
| `seedingMinPlayers` | no | — | `1` | Minimum player count required before seeding can start for the current round. |
| `liveTarget` | no | — | `70` | Player count at or above which the server is considered live and seeding closes. |
| `seedingReopenBelow` | no | — | `65` | Player count that must be crossed downward before seeding can reopen in the same round. |
| `seedingReopenDelayMinutes` | no | — | `2` | Continuous minutes below seedingReopenBelow required before seeding reopens in the same round. |
| `minUnlockedSquadSize` | no | — | `3` | Minimum squad size required for unlocked squad leaders to qualify during live play. |

### PteroMonitor

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `apiPrefix` | no | — | `https://panel.example.com` | The API site url. |
| `serverUUID` | yes | — | `null` | The UUID of the server to pull stats from. |
| `apiToken` | yes | — | `null` | The API token. |
| `updateInterval` | no | — | `10` | The update interval for the server to pull stats from (in seconds). |
| `fetchTimeout` | no | — | `8` | Maximum time to wait for the panel API before skipping this sample (in seconds). |

### RollingFileLogger

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `logDir` | no | — | `./logs/squadjs` | Directory where rolling SquadJS log files will be written. |
| `retention` | no | — | `10` | Number of newest rolling log files to retain. |
| `filenamePrefix` | no | — | `squadjs` | Prefix used for rolling log file names. |
| `includeConsole` | no | — | `true` | When true, direct <code>console.log</code>, <code>console.error</code>, and <code>console.trace</code> calls are also written to the file. |
| `stripAnsi` | no | — | `true` | When true, ANSI color and cursor control sequences are removed from file output. |

### SeedingMode

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `interval` | no | — | `150000` | Frequency of seeding messages in milliseconds. |
| `seedingThreshold` | no | — | `50` | Player count required for server not to be in seeding mode. |
| `seedingMessage` | no | — | `Seeding Rules Active! Fight only over the middle flags! No FOB Hunting!` | Seeding message to display. |
| `liveEnabled` | no | — | `true` | Enable "Live" messages for when the server goes live. |
| `liveThreshold` | no | — | `52` | Player count required for "Live" messages to not bee displayed. |
| `liveMessage` | no | — | `Live!` | "Live" message to display. |
| `waitOnNewGames` | no | — | `true` | Should the plugin wait to be executed on NEW_GAME event. |
| `waitTimeOnNewGame` | no | — | `30` | The time to wait before check player counts in seconds. |

### SmartSwitch

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `commandPrefix` | no | — | `["!switch","!change"]` | Prefix of every switch command, can be an array |
| `doubleSwitchCommands` | no | — | `[]` | Array of commands that can be sent in every chat to request a double switch |
| `doubleSwitchCooldownHours` | no | — | `0.5` | Hours to wait before using again one of the double switch commands |
| `doubleSwitchDelaySeconds` | no | — | `1` | Delay between the first and second team switch |
| `endMatchSwitchSlots` | no | — | `3` | Number of switch slots, players will be put in a queue and switched at the end of the match |
| `switchCooldownHours` | no | — | `3` | Hours to wait before using again the !switch command |
| `switchEnabledMinutes` | no | — | `5` | Time in minutes in which the switch will be enabled after match start or player join |
| `doubleSwitchEnabledMinutes` | no | — | `5` | Time in minutes in which the switch will be enabled after match start or player join |
| `maxUnbalancedSlots` | no | — | `3` | Number of player of difference between the two teams to allow a team switch |
| `switchToOldTeamAfterRejoin` | no | — | `false` | The team of a disconnecting player will be stored and after a new connection, the player will be switched to his old team |
| `database` | yes | `sequelize` | `mysql` | The Sequelize connector used by DBLog. Select the same durable primary connector alias as DBLog because SmartSwitch reads DBLog match, death, wound, and revive history in addition to storing its own state. |
| `memberPrefix` | no | — | `` | The prefix to decide who is a member or not. |
| `channelID` | yes | — | `` | The ID of the Discord channel to log squad balancing events to. |
| `color` | no | — | `16761867` | The color of the embed for Discord logging. |
| `testMode` | no | — | `false` | When enabled, performs database validation but skips any actual team balancing actions. |
| `consecutiveWinsThreshold` | no | — | `3` | Number of consecutive round wins before triggering reshuffle. |
| `shuffleDelaySeconds` | no | — | `15` | Delay in seconds after round end before performing the reshuffle. |
| `recentShuffleClearMinutes` | no | — | `15` | Minutes after a shuffle to clear the recent shuffle switch lockout. |
| `showBroadcasts` | no | — | `true` | Whether to broadcast messages about the reshuffling action. |
| `considerTicketDifference` | no | — | `false` | Whether to require a minimum ticket difference to count a round win. |
| `ticketDifferenceThreshold` | no | — | `200` | Ticket difference threshold for non-invasion layers to count as a valid win. |
| `invasionTicketDifferenceThreshold` | no | — | `700` | Ticket difference threshold for invasion layers to count as a valid win. |
| `excludedLayers` | no | — | `["seed","jensen"]` | An array of layer identifiers to exclude (case insensitive). |
| `killWeight` | no | — | `1` | Weight factor for kills in performance calculation. |
| `reviveWeight` | no | — | `1` | Weight factor for revives in performance calculation. |
| `teamkillWeight` | no | — | `-2` | Weight factor for teamkills in performance calculation (negative value reduces score). |

### SocketIOAPI

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `websocketPort` | yes | — | `` | The port for the websocket. |
| `securityToken` | yes | — | `[redacted]` | Your secret token/password for connecting. |

### SquadBaiting

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log admin broadcasts to. |
| `warnInGameAdmins` | no | — | `true` |  |
| `resetPlayerCountersAtNewGame` | no | — | `true` |  |
| `disableDefaultAdminWarns` | no | — | `false` |  |
| `playerRules` | no | — | `[]` | Set of rules that will be applied on player events |
| `squadRules` | no | — | `[]` | Set of rules that will be applied on squad events |

### SquadCreationBlocker

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `blockDuration` | no | — | `15` | Time period after a new game starts during which custom squad creation is blocked (in seconds). |
| `broadcastMode` | no | — | `false` | If true, uses countdown broadcasts. If false, sends individual warnings to players. |
| `allowDefaultSquadNames` | no | — | `true` | If true, allows creation of squads with default names (e.g., "Squad 1") during the blocking period. |
| `rateLimitEnforced` | no | — | `false` | If true, enables rate limiting on custom squad creation. If false, rate limiting is disabled. |
| `rateLimitWindow` | no | — | `2` | The time window (in seconds) within which a player can create a maximum number of custom squads before triggering the backoff. |
| `rateLimitMaxSquads` | no | — | `3` | The maximum number of custom squads a player can create within the rate limit window. |
| `rateLimitBackoffTime` | no | — | `10` | The time (in seconds) a player must wait after exceeding the rate limit before creating another custom squad. |

### SquadNameValidator

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log admin broadcasts to. |
| `warningMessage` | no | — | `Your squad has been disbanded due to non-compliant name. Forbidden: %FORBIDDEN%` |  |
| `rules` | no | — | `[{"type":"regex","logic":"match=allow","rule":{}}]` |  |

### TeamRandomizer

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `command` | no | — | `randomize` | The command used to randomize the teams. |

### TpsLogger

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `commandPrefix` | no | — | `!tps` | Prefix of every in-game command |
| `httpServerEnabled` | yes | — | `false` | Enables/Disables the http server that hosts the TPS history with events |
| `httpServerPort` | no | — | `3030` | The port used by the http server |
| `tpsHistoryLength` | no | — | `200` |  |
| `simulateTpsDrops` | no | — | `false` |  |

### unnAdminRequest

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The Discord channel in which admin requests are created. |
| `ignoreChats` | no | — | `[]` | Chat channels from which admin requests should be ignored. |
| `ignorePhrases` | no | — | `[]` | Request phrases that should be ignored. |
| `command` | no | — | `admin` | The in-game chat command that creates an admin request. |
| `pingGroups` | no | — | `[]` | Discord role IDs or names to mention when the ping cooldown permits. |
| `pingDelay` | no | — | `60000` | Cooldown between Discord role mentions in milliseconds. |
| `color` | no | — | `16761867` | The color of the request embed. |
| `warnInGameAdmins` | no | — | `false` | Relay a new request directly to connected in-game admins. |
| `showInGameAdmins` | no | — | `true` | Tell the requester how many in-game admins are connected. |
| `autocloseAfterMinutes` | no | — | `10` | Close an unresolved request after this many minutes. |

### unnServerProfiler

Generated enabled default: `false`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The Discord channel that receives profiler reports. |
| `enableFileCompression` | no | — | `true` | Compress profiler CSV attachments. |
| `discordWebhook` | no | — | `null` | Optional Discord webhook URL used instead of channelID. |
| `minimumPlayerCount` | no | — | `1` | Minimum connected players required to start profiling. |
| `profilingFileDurationMinutes` | no | — | `null` | Minutes per capture. Null disables timed capture rotation. |
| `storeProfilerFilesOnlyIfTpsDropDetected` | no | — | `false` | Discard routine captures and report only captures stopped by a TPS drop. |
| `overrideSquadGameDir` | no | — | `null` | Absolute path to the SquadGame directory. |
| `detectTPSDrops` | no | — | `false` | Stop and report a capture when recent TPS falls 20% below its baseline. |
| `simulateTpsDrops` | no | — | `false` | Inject occasional low TPS samples for test environments. |
| `compressionMethod` | no | — | `zip` | Attachment compression format: zip or gzip. |
| `generateCharts` | no | — | `true` | Attach a lightweight SVG chart generated from numeric CSV columns. |

### VehicleEnteredLogger

Generated enabled default: `true`.

| Option | Required | Connector | Default | Description |
| --- | --- | --- | --- | --- |
| `discordClient` | yes | `discord` | `discord` | Discord connector name. |
| `channelID` | yes | — | `` | The ID of the channel to log admin broadcasts to. |


## SmartSwitch behavior

[SmartSwitch options](#smartswitch) control requests, queues and automatic balancing.

- Automatic shuffling and balancing keep parties together, even across squads. A party that cannot fit can leave a residual imbalance.
- An ordinary member's explicit request is individual. A leader's request includes the entire party and checks the projected team gap before moving anyone.
- Failed queues and partial shuffle destinations are retained. Overlapping queued players and squads are deduplicated; cooldowns are recorded only for observed moves.
- The queue table's nullable `targetTeamID` column is added by an idempotent migration. Queue destinations persist across retries and restarts; in-memory squad and shuffle plans last only for the plugin instance.

Whole-party moves use the roster's `isLeader` flag as the party-leader signal. See the [shared team-switch contract](../contracts/legacy-plugin-compatibility.md#party-aware-team-changes) for roster validation and command verification.

## Native plugins

Module paths below are for the compiled runtime. Option defaults come from each definition; connector aliases map to keys in your main config. No plugin is created or mounted during generation.

### discordOperations

Lists or removes bot application commands under configured administrator permissions.

Module: `./dist/src/plugins/builtin/discord-operations.js` · API: `1`.

| Alias | Connector type | Required | Description |
| --- | --- | --- | --- |
| `discord` | `discord` | yes | Discord bot whose application commands are managed. |

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `guildID` | `string` | yes | `no default` | Discord guild where the operator command is registered. |
| `commandName` | `string` | no | `clear-application-commands` | Guild slash-command name. |
| `allowedRoleIDs` | `string[]` | no | `[]` | Discord roles permitted to manage application commands. |
| `allowAdministrator` | `boolean` | no | `true` | Permit members with Discord Administrator permission. |

### discordRoundEnded

Posts end-of-round results to configured Discord channels.

Module: `./dist/src/plugins/builtin/discord-round-ended.js` · API: `1`.

| Alias | Connector type | Required | Description |
| --- | --- | --- | --- |
| `discord` | `discord` | yes | Discord bot used to deliver completed match results. |

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `channelIDs` | `string[]` | no | `[]` | Discord channels that receive completed match results. |
| `color` | `number` | no | `16761867` | The color of the result embed. |

### errorNotify

Reports matching server-log text to Discord, with optional bounded log attachments.

Module: `./dist/src/plugins/builtin/error-notify.js` · API: `1`.

| Alias | Connector type | Required | Description |
| --- | --- | --- | --- |
| `discord` | `discord` | yes | Discord bot used to deliver notifications. |

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `channelID` | `string` | yes | `no default` | Discord channel that receives match notifications. |
| `patterns` | `string[]` | yes | `no default` | Strings that trigger a notification when they appear in a Squad log line. |
| `mentionRoleIDs` | `string[]` | no | `[]` | Discord roles mentioned on each notification. |
| `caseSensitive` | `boolean` | no | `false` | Match patterns with exact letter case. |
| `cooldownSeconds` | `number` | no | `300` | Minimum interval between notifications for the same pattern; repeats are counted. |
| `attachLog` | `boolean` | no | `true` | Attach a compressed copy of the current SquadGame.log to each notification. |
| `maximumAttachmentBytes` | `number` | no | `10485760` | Largest compressed attachment Discord accepts for the channel; larger logs are trimmed. |
| `maximumSourceBytes` | `number` | no | `2147483648` | Maximum uncompressed SquadGame.log size copied for one notification. |

### logGrabber

Provides a permission-controlled Discord command for bounded server-log downloads.

Module: `./dist/src/plugins/builtin/log-grabber.js` · API: `1`.

| Alias | Connector type | Required | Description |
| --- | --- | --- | --- |
| `discord` | `discord` | yes | Discord bot used to register and answer the slash command. |

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `guildID` | `string` | yes | `no default` | Discord guild where the slash command is registered. |
| `commandName` | `string` | no | `server-log` | Guild slash-command name. |
| `allowedRoleIDs` | `string[]` | no | `[]` | Discord roles permitted to download the server log. |
| `allowedChannelIDs` | `string[]` | no | `[]` | Channels where the command may run; empty permits every guild channel. |
| `allowAdministrator` | `boolean` | no | `true` | Permit members with Discord Administrator permission. |
| `ephemeral` | `boolean` | no | `false` | Send successful log downloads as ephemeral interaction responses. |
| `maximumSourceBytes` | `number` | no | `2147483648` | Maximum uncompressed SquadGame.log size accepted for one request. |

### rconRecorder

Archives shared-client RCON command outcomes and pushed bodies as bounded JSONL/gzip files, without extra commands or authentication packets.

Module: `./dist/src/plugins/builtin/rcon-recorder.js` · API: `1`.

None.

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `directory` | `string` | no | `./rcon-recordings` | Dedicated recording directory, resolved from process working directory; use a separate directory per process/instance. |
| `recordLogLines` | `boolean` | no | `false` | Include raw game-log lines; may contain player identities, IPs and chat. Disabled by default. |
| `retentionDays` | `number` | no | `14` | Delete closed recordings older than this many days. |
| `maxTotalMB` | `number` | no | `1024` | Hard byte budget in MiB for recorder-owned active, archived and compression scratch files. |
| `maxFileMB` | `number` | no | `16` | Rotate at this many MiB or a UTC hour change; must not exceed maxTotalMB. |
| `maxBufferMB` | `number` | no | `4` | Maximum queued serialized MiB; excess entries are dropped without delaying RCON. |
| `maxEntryKB` | `number` | no | `64` | Maximum serialized KiB per entry (at least 1); long text is truncated and marked. |
| `maxDedupEntries` | `number` | no | `1024` | Maximum cached command/response fingerprints for same-response deduplication per file. |
| `compress` | `boolean` | no | `true` | Gzip closed files when source plus scratch fits the total budget; otherwise retain JSONL. |


## RCON recorder behavior

The native `rconRecorder` example is disabled. It records shared-client command outcomes and unsolicited pushed bodies while mounted; it sends no extra commands and excludes authentication packets. Its implementation was inspired by [lbzepoqo's RconRecorder](https://github.com/lbzepoqo/SquadJS/blob/0f686f8300270a8eb50b726d476a7c28771cd938/squad-server/plugins/rcon-recorder.js), with native subscriptions and new bounded storage. Original SquadJS copyright and Boost Software License notices are retained in source and `LICENSE`.

`directory`, `retentionDays` and `maxTotalMB` retain their upstream purpose. `recordLogLines` now defaults to false; enable it explicitly to include raw game-log content. The new file, queue, entry and deduplication bounds are listed in the options table. Limits use MiB/KiB (1024-based). Commands, responses and pushes may contain chat, player IDs/IPs, moderation details or operator-supplied secrets; protect the dedicated directory. New directories/files use modes 0700/0600 where supported. Existing directory permissions are not changed. Never share a directory between processes or recorder instances; overlapping instances in one process are rejected. Only filenames owned by this recorder are pruned, leaving unrelated files alone.

Each JSONL entry has `schemaVersion: 1`, `serverID`, `type` and a UTC `time`. Command records additionally carry request ID, request/send times, duration and success/error outcome. Authentication packets are never emitted, and occurrences of the configured RCON password in RCON audit text are redacted without changing the returned response. The opt-in raw game-log view also redacts the configured RCON password; other secrets in application/log content are not automatically identified. Oversized text is shortened with a `truncated` field naming the affected fields. Records larger than the configured serialized entry limit are dropped.

Successful repeated responses use `same: true` instead of `response`, keyed by the SHA-256 `commandKey` of the complete audited command. References are to the last written successful response for that key in the same file. The bounded cache resets per file; evicted entries are written in full again. A file with truncated responses is not a lossless replay of all original content.

Files rotate at UTC hour changes or `maxFileMB`; filenames include a unique suffix, so a backwards clock or repeated hour cannot reopen an older file. Completion timestamps choose the command's hour. One worker serializes writes, rotation, gzip and retention. `maxTotalMB` counts the active file and reserves compression scratch as well as archives. Oldest closed files are removed first, with age retention and a 1024-file ceiling. If gzip cannot fit alongside its source, JSONL is retained. Startup removes interrupted scratch files and compresses surviving JSONL when the budget permits. Maintenance also rotates idle hours and applies retention once a minute.

Slow disk does not block RCON: the queue is limited by serialized bytes and 4096 entries, and excess entries are dropped. A first overload warning, minute summaries and shutdown totals report drops, oversized entries and I/O failures without their content. Failed writes are rolled back where possible and later entries retry. Unmount unsubscribes, stops maintenance, drains accepted entries, closes the file and waits for compression; later callbacks cannot reopen files.
