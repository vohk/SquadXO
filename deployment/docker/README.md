# Docker

Build from the repository root:

```sh
docker build -f deployment/docker/Dockerfile -t squadxo .
docker run --rm --init --mount type=bind,src="$(pwd)/config.json",dst=/app/config.json,readonly squadxo
```

The build creates the compiled production archive and installs production dependencies. Startup directly executes Node 24; it does not install packages or rewrite configuration. The Dockerfile-specific ignore file excludes local config, databases, credentials and Git history from the build context.

Add your chosen game/log/admin-list/database mounts and use their container paths in `config.json`. The process runs as UID/GID 1000; writable database/log mounts need matching access. No port is exposed. Update by rebuilding/replacing the container while retaining the same mounts; application files live in the image, and user data belongs in mounts.
