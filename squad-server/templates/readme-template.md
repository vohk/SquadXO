# SquadXO

![SquadXO](squadxo-header.png)

*Your server’s second-in-command.*

SquadXO connects to a Squad dedicated server through RCON and `SquadGame.log`, maintains live server state, and runs administration, Discord and database plugins. It is derived from [SquadJS](https://github.com/Team-Silver-Sphere/SquadJS) and maintained by [The Unnamed](https://joinunn.com).

- EOS-first player state and DBLog history, while retaining optional Steam IDs for existing integrations.
- A versioned native plugin API with typed options and connectors, scoped resource cleanup, and legacy plugin compatibility.
- Supports persistance through PostgreSQL, MariaDB/MySQL and SQLite.
- Ergonomic improvements like layer-list sources in configs, automatic ordering of config keys, and more.

**Upgrading from SquadJS or an earlier fork?** Back up your application, configuration and database, and read [Migration](docs/deployment/migration.md) before starting the new runtime. Keep your working config; generated defaults are examples, not a replacement for production settings.

> [!NOTE]
> SquadXO has been my personal project to maintain The Unnamed's SquadJS ecosystem and learn a little bit about the guts at the same time. It is unashamedly AI-developed, although hopefully exercised enough to avoid being slop. We’ve been using it in production for 3 months as of the v1.0.0 release.
> [!WARNING]
>
> SquadXO is *almost* a drop in replacement for a standard SquadJS installation, but there are some important caveats:
>
> * If you have multiple SquadJS instances writing to the same database, be sure to read [migration.md](docs/deployment/migration.md) carefully. Complete the EOS ID backfill from a single instance before bringing the others online.
> * All stock legacy plugins should either be supported or explicitly superseded. Please open an issue for any breakage found.
> * Custom legacy plugins with unusual behaviour may not function due to deliberate compatibility limitations, and should generally be migrated to the new native interface.

## Setup

Use Node.js 24.x. The [production guide](docs/deployment/production.md#install-and-start) covers archive verification, configuration, startup and rollback. A compiled release needs only production dependencies; do not run build or generation commands in an extracted release.

```sh
npm ci --omit=dev
node --unhandled-rejections=warn index.js
```

Local log tailing is preferred; SFTP is supported for separate hosts. See [Deployment](docs/deployment/production.md), [Configuration and plugin reference](docs/reference/plugins.md) and the [Native plugin API](docs/contracts/native-plugin-authoring.md).

## Source checkout

See [CONTRIBUTING.md](CONTRIBUTING.md) for code conventions, tests and generator commands.

```sh
npm ci
npm run build
```

`build` clears `dist/` and compiles the runtime and tests there; it does not start the server or generate configuration. Keep production `config.json` beside `index.js` and run the startup command above from that application root.

After changing plugin metadata or documentation templates, run `npm run build-all` to rebuild and regenerate the default config, README and plugin reference. `npm run build-reference` rebuilds and regenerates only the reference when that is all you need. Regenerate and commit changed artifacts before packaging; release packaging checks generator equality and a clean Git checkout.

## Credits and license

Derived from Thomas Smyth and the Team Silver Sphere contributors’ SquadJS. Thanks to [Davide Fantino](https://github.com/fantinodavide) and [lbzepoqo](https://github.com/lbzepoqo) for their contributions. Individual notices remain in source. Maintained by The Unnamed under the [Boost Software License 1.0](LICENSE).
