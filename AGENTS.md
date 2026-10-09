# SquadXO orientation

`index.js` enters `src/main.ts` through the compiled runtime. `src/server/integrated-runtime.ts` coordinates log/RCON input, state reduction, DBLog and plugin lifecycles. Legacy JavaScript plugins remain in `squad-server/plugins/`; `src/compatibility/` supplies their server facade, event translation and loading plan. Changes to shared events or state often affect both native and legacy consumers.

Player identity is EOS-first; Steam IDs are optional compatibility data. Consult the [DBLog schema](docs/contracts/db-log-schema.md) for persistence and SQL consumers. Native plugins use the [versioned context API](docs/contracts/native-plugin-authoring.md), still imported as `SquadJS/plugin-api`. The context owns subscriptions, timers and tracked tasks; directly installed connector listeners need `unmount()` cleanup. The [legacy contract](docs/contracts/legacy-plugin-compatibility.md) describes the other boundary.

`npm run build` clears and compiles runtime and tests. `npm test` rebuilds through the isolated runner; focused commands and subsystem test paths are in [CONTRIBUTING.md](CONTRIBUTING.md).

Generated config, README and plugin reference come from `squad-server/templates/` and plugin metadata. `npm run build-all` updates all three; README generation also updates the reference. Metadata generation reads compiled native definitions without creating plugins. Runtime source or legacy plugin/layer additions and removals also require reviewing [the package inventory](scripts/package-inputs.json).
