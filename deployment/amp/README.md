# AMP

Linux GenericModule files for AMP 2.6.0.0+. Place `manifest.json`, `squadxo.kvp` and `squadxo*.json` at the root of a local `ADS01/Plugins/ADSModule/DeploymentTemplates/LOCALSquadXO-main` repository, per [AMP's custom-template layout](https://github.com/CubeCoders/AMP/wiki/Configuring-the-%27Generic%27-AMP-module#adding-custom-templates-to-amp). This repository's `deployment/amp` subdirectory cannot be used directly as an AMP `owner/repo:branch` Configuration Repository.

The Node Executable setting defaults to `/usr/bin/node`. Install Node 24 and its npm in the instance environment and set its absolute executable path; Update and startup use the same binary. A per-instance runtime can follow the [official Node template](https://github.com/CubeCoders/AMPTemplates/blob/main/node.kvp) pattern with Node 24 selected. `cubecoders/ampbase:debian` does not supply Node 24 automatically; containerized instances need it installed inside the container. Native dependencies may require Python, make and a C++ compiler when prebuilt binaries are unavailable.

Update selects Public GitHub Repository and Release Tag, installing into the instance's `squadxo/` root. Startup uses `squadxo/config.json`. There are no listening ports or pre-start install/config-edit stages. See [preservation and rollback](../README.md).
