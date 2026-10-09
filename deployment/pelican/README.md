# Pelican

Pelican accepts PTDL_v2, so use [`../pterodactyl/egg-squadxo.json`](../pterodactyl/egg-squadxo.json) with the same Node 24 images and release variables. No separate export is needed.

Mount destinations are configuration choices; paths such as `/mnt/squad` work without changing the egg. See [preservation and rollback](../README.md).

References: [egg importer](https://github.com/pelican-dev/panel/blob/main/app/Services/Eggs/EggImporterService.php), [mount constraints](https://pelican.dev/docs/guides/mounts/).
