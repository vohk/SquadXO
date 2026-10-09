# Deployment

- [Pterodactyl](pterodactyl/README.md), [Pelican](pelican/README.md) and [WISP](wisp/README.md) share one PTDL_v2 egg.
- [AMP](amp/README.md) uses a Linux GenericModule template.
- [Docker](docker/README.md) builds from this repository.

Panel templates download `squadxo-v*.tar.gz` deployment assets and their `.sha256` files from `SQUADXO_REPO` (default `vohk/SquadXO`) at `SQUADXO_TAG` (default `latest`). They verify the archive checksum and complete `SHA256SUMS` manifest, reject archive links and unsafe paths, and require Node.js 24 for installation and startup.

Create `config.json` beside the root `index.js`; `.squadxo/current/config.example.json` is the reference. Startup only runs `index.js` with your configuration. Log, admin-list and database paths can point to any available mount; no RCON settings are rewritten.

Panel updates install dependencies into a fresh `.squadxo/releases/<id>` directory and atomically switch `.squadxo/current` after success. They preserve `config.json`, all `SquadGame/`, `ServerConfig/`, `Saved/` and `Logs/` trees, external links/mounts, database paths and other user files. An absent mount destination is never populated. Collisions with the managed `.squadxo` directory or root `index.js` entry point fail before installation. Existing source installs need a separate application root.

Stop the application before updating. Use Update where available; Pterodactyl/Pelican Reinstall reruns the installer. Their Wings implementations retain files outside script changes, but provider cleanup before the script is beyond its control. Installer containers may not expose runtime mounts.

Previous and failed release directories remain intact; there is no automatic pruning. Roll back from the server root with `node /path/to/deployment/shared/install.mjs --rollback <previous-id>`. IDs are printed on activation and listed under `.squadxo/releases`. Rollback verifies original application files; it does not revert configuration or database migrations. Inspect an interrupted install's `.squadxo-lock` before removing it.

Edit `shared/install.mjs` and `shared/generate.mjs`, then run `node deployment/shared/generate.mjs`; `--check` verifies the embedded scripts match.
