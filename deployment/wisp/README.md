# WISP

WISP accepts the shared [`../pterodactyl/egg-squadxo.json`](../pterodactyl/egg-squadxo.json). A separate egg is unnecessary.

[`update.sh`](update.sh) is the optional Update Script field content, separate from egg JSON. It expects `/home/container`, Node 24 and the egg's `SQUADXO_REPO`/`SQUADXO_TAG` environment. Stop SquadXO before Update. See [preservation and rollback](../README.md).

References: [egg support](https://gamepanel.notion.site/Eggs-Games-e3e81ca8b89f493ca975866f329a5d5c), [Update Script](https://gamepanel.notion.site/Advanced-Update-Script-7c021eafd1244e7d811cfc2169a78b87).
