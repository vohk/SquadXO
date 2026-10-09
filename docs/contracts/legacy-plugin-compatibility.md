# Legacy plugin compatibility contract

The legacy facade preserves the documented behavior required by maintained source plugins while they migrate to the native API. It does not recreate arbitrary historical SquadJS internals. Compatibility is measured by plugin intent: populated state, resolved event participants, RCON operations, connector access, lifecycle ordering, and cleanup must remain functional rather than merely exposing similarly named properties.

The historical `server.restartRCON()` and `server.restartLogParser()` functions are deprecated and not supported by the facade. The runtime owns these components and provides automatic RCON reconnection, log replacement handling, and SFTP recovery. Operators should restart the complete service when manual recovery is required. A plugin must not receive a fake successful response for an operation the runtime did not perform.

Legacy plugins that depend on unsupported internals may be removed from the maintained tree rather than shimmed. Historical source may be retrieved from the upstream SquadJS repository. `DiscordSubsystemRestarter` was removed under this policy because its only operations are the unsupported subsystem restarts.

## Party-aware team changes

SmartSwitch and TeamRandomizer keep each party together during automatic shuffling and balancing, including party ID zero and parties spanning squads. Under the current server assumption, the single `Is Leader` member is also the party leader; that leader is commanded first. Missing or multiple leaders stop a whole-party move with an explicit error. An ordinary member's explicit SmartSwitch request remains individual; a leader request includes the entire party and checks its projected team gap before moving anyone. Parties can leave a residual imbalance when no whole party fits.

Switchers refresh the roster and verify the destination after each command. A server-moved party member already at its destination is skipped. Empty, malformed, duplicate, or incomplete rosters stop the operation; an unconfirmed command is not automatically retried. SmartSwitch retains failed queues and partial shuffle destinations, deduplicates overlapping queued players and squads, and records cooldowns only for observed moves. Its queue table gains a nullable `targetTeamID` through an additive, idempotent migration. Queue destinations survive retries; in-memory squad/shuffle plans survive only while the plugin instance runs.

Keep local plugins disabled during parser capture and offline verification. These changes have not been validated by performing production team changes; review the deployed server's leader behavior before enabling the switchers there.

## External modules

Legacy configuration may select an external ESM module explicitly:

```json
{ "plugin": "ExamplePlugin", "module": "../external-plugins/example.mjs", "enabled": true }
```

The module path is resolved relative to the configuration file. It must export a default class whose name matches `plugin`; options and connector requirements retain the legacy behavior. Disabled entries are not imported. Explicit modules bypass bundled discovery, allowing self-contained/minified plugins without relying on source-text class discovery. Name-only minified discovery matches the configured class name to a kebab-case `.min.js` or `.build.min.js` filename (with an optional historical `squadjs-` prefix); unrelated minified files are skipped without being read or imported. Module imports are trusted executable code; planning imports them before runtime connections start. Keep external modules and their dependencies outside the replaceable release directory. Relative imports and package dependencies resolve from the external module's directory, not from the configuration file. Unbundled plugins that import `./base-plugin.js` need that sibling dependency (a local re-export of the release's maintained base class is sufficient) and their own resolvable dependencies; the loader does not install them. Native modules use their existing `type: "native"` configuration instead.
