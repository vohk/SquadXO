# Pterodactyl

[`egg-squadxo.json`](egg-squadxo.json) is PTDL_v2 for Pterodactyl 1.x. Runtime: `ghcr.io/ptero-eggs/yolks:nodejs_24`. Installer: `node:24-trixie-slim`. Keep both on Node 24. `SQUADXO_REPO` and `SQUADXO_TAG` select the public release; startup uses the server-root `config.json`.

Reinstall runs the shared installer; see [preservation and rollback](../README.md). The egg has no config-edit rules or required mounts.

References: [egg importer](https://github.com/pterodactyl/panel/blob/1.0-develop/app/Services/Eggs/EggImporterService.php), [Wings install](https://github.com/pterodactyl/wings/blob/develop/server/install.go).
