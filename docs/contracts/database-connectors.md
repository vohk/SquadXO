# Database connector contract

Connector keys are aliases, not database types. A plugin selects an alias in its configuration, and the connector stored under that alias determines the Sequelize dialect. Names such as `primary`, `postgres`, `mysql`, and `tracker-state` have no special runtime meaning.

The generated default selects `sqlite:database.sqlite`, a persistent file relative to the process working directory. SQLite is a lightweight single-instance option. Keep the file on a writable local persistent path and back it up; use an absolute storage path when release directories change. PostgreSQL, MariaDB or MySQL is preferred for production, shared databases and multiple writers. The default does not enable optional plugins or fall back to another database.

## Recommended topology

- Configure one durable primary connector for production data. It may use PostgreSQL, MariaDB, or MySQL. SQLite also supports a persistent local file for a single-instance deployment.
- Enable DBLog before using its historical data, and point plugins that need that data at the same connector alias. AltChecker and PteroMonitor use DBLog’s connector automatically.
- Point SmartSwitch at DBLog's connector alias. SmartSwitch stores its own queue and balancing state through that connector, but it also directly reads DBLog's match, death, wound, and revive tables to calculate player and squad performance. A separate SQLite connector would isolate it from that history and prevent those calculations from working.
- SQLite may store durable local state when its file is retained and backed up. Avoid memory-only storage for persistence and shared files across several writer processes.
- A connector alias is initialized once and the resulting Sequelize instance is shared by every plugin that selects it.
- Configure historical EOS backfill only on one DBLog instance at a time. A database lease rejects concurrent workers, but a single designated instance keeps operational ownership clear.
- Two connectors may use the same dialect. Their aliases still identify separate connection and lifecycle scopes.

For example, this configuration uses PostgreSQL for durable data and a separate SQLite database for PlayerStateTracker sessions:

```json
{
  "connectors": {
    "primary": {
      "database": "squadjs",
      "dialect": "postgres",
      "host": "localhost",
      "password": "password",
      "port": 5432,
      "schema": "squad",
      "username": "squadjs"
    },
    "tracker-state": "sqlite:tracker-state.sqlite"
  },
  "plugins": [
    { "plugin": "DBLog", "enabled": true, "database": "primary" },
    { "plugin": "SmartSwitch", "enabled": true, "database": "primary" },
    {
      "plugin": "PlayerStateTracker",
      "enabled": true,
      "database": "tracker-state"
    }
  ]
}
```

MariaDB or MySQL uses the same structure with the matching Sequelize `dialect` and port. Existing configurations that call their primary connector `mysql` remain valid even if a different alias is preferred for new deployments.

Enabled DBLog persists EOS IDs and optional Steam IDs in `DBLog_Players`. The public release no longer supplies the separate identity cache; existing `EOS_SteamIDtoEOSIDs` data is retained but receives no new writes. External consumers of that table need an explicit migration to DBLog.

SQLite is not a fallback for a failed primary database. Each plugin must explicitly select its intended connector, and startup fails when that named connector is absent or cannot authenticate. `PlayerStateTracker` temporarily accepts an omitted `database` option by reusing DBLog's connector for backward compatibility and logs a deprecation warning; new configurations should always set the alias explicitly.
