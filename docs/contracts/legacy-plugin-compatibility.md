# Legacy plugin compatibility contract

The legacy facade preserves the documented behavior required by maintained source plugins while they migrate to the native API. It does not recreate arbitrary historical SquadJS internals. Compatibility is measured by plugin intent: populated state, resolved event participants, RCON operations, connector access, lifecycle ordering, and cleanup must remain functional rather than merely exposing similarly named properties.

The historical `server.restartRCON()` and `server.restartLogParser()` functions are deprecated and not supported by the facade. The runtime owns these components and provides automatic RCON reconnection, log replacement handling, and SFTP recovery. Operators should restart the complete service when manual recovery is required. A plugin must not receive a fake successful response for an operation the runtime did not perform.

Legacy plugins that depend on unsupported internals may be removed from the maintained tree rather than shimmed. Historical source may be retrieved from the upstream SquadJS repository. `DiscordSubsystemRestarter` was removed under this policy because its only operations are the unsupported subsystem restarts.

## Party-aware team changes

The shared team-switch helper groups players by team and party ID, including party ID zero and parties spanning squads. Disabling squad grouping does not disable party grouping. For a multi-player party move, exactly one current member must have `isLeader`; that member is commanded first. The raw flag is not a separately verified party-leader identity. SmartSwitch skips ambiguous parties rather than guessing.

The helper uses a fresh roster and verifies the destination after each command. An unchanged, just-verified roster may serve as the next baseline only within 100 ms of receipt while the shared RCON connection is idle and its command/reconnection version remains unchanged; edited observations or intervening requests force a new read. It skips planned players already at their destination, including members moved with their leader by the server. Empty, invalid, duplicate or incomplete rosters stop the operation. Unconfirmed commands are not automatically retried, and unexpected moves outside the plan stop further commands.

SmartSwitch shuffle plans are local to one round-end attempt. They preflight current membership and team before issuing commands, skip unsafe groups and continue independent groups. Authoritative shuffle roster reads allow genuine departures without comparing against the periodic player cache. Confirmed departures remove only missing targets; ordinary survivors continue. Surviving parties are revalidated against fresh membership and leadership before another command. Ambiguous leadership, split teams or unplanned party members skip unsafe survivors. An observed target returning from its confirmed destination stops execution without a second command. The round generation is captured before queue preparation and checked throughout execution; cancelled groups are counted once. Post-command verification still stops an attempt on malformed data, unconfirmed destinations or movement outside the plan. No shuffle destinations are carried into the next round; explicit player/squad queues retain their existing destination semantics.

See [SmartSwitch behavior](../reference/plugins.md#smartswitch-behavior) for request, queue and balancing policy.

## External modules

Legacy configuration may select an external ESM module explicitly:

```json
{ "plugin": "ExamplePlugin", "module": "../external-plugins/example.mjs", "enabled": true }
```

The module path is resolved relative to the configuration file. It must export a default class whose name matches `plugin`; options and connector requirements retain the legacy behavior.

Disabled entries are not imported. Explicit modules bypass bundled discovery, allowing self-contained/minified plugins without relying on source-text class discovery.

Name-only minified discovery matches the configured class name to a kebab-case `.min.js` or `.build.min.js` filename (with an optional historical `squadjs-` prefix); unrelated minified files are skipped without being read or imported.

Module imports are trusted executable code; planning imports them before runtime connections start.

Relative imports and package dependencies resolve from the external module's directory, not from the configuration file.

Unbundled plugins that import `./base-plugin.js` need that sibling dependency (a local re-export of the release's maintained base class is sufficient) and their own resolvable dependencies; the loader does not install them.

Native modules use their existing `type: "native"` configuration instead.
