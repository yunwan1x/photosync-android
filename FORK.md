# Photos Immich fork

This repository replaces the former custom Photos Android, web, and server
implementations with the complete Immich source tree.

## Upstream baseline

- Project: [immich-app/immich](https://github.com/immich-app/immich)
- Release: `v3.0.3`
- Commit: `cd308ad93093735135f99d85ce6980c8e93df231`
- License: GNU Affero General Public License v3.0 (`LICENSE`)

The Android dependency changes from upstream commit
`507448d797d928ac3675c0e3a380f304925fcdea` are applied on top of the release:
`home_widget` is updated from `0.8.1` to `0.9.3`, and its obsolete Glance
constraint is removed. This fixes the reproducible JVM-target failure in the
v3.0.3 Android release build without importing unrelated later mobile changes.

The pre-Immich implementation remains recoverable from the Git tag
`photos-legacy-ce4b845`. Runtime data and locally generated APKs were archived
outside the repository before replacement. They are not migration inputs for
this fresh installation.

## Project-specific files

- `AGENTS.md`: security and production deployment constraints.
- `docker/docker-compose.photosync.yml`: production HTTP Compose definition.
- `docker/photosync.env.example`: non-secret environment template.
- `scripts/test-server.sh`: mandatory server verification before publishing.
- `scripts/build-android.sh`: repeatable Android APK build.
- `deploy.sh`: build, push, SSH deploy, smoke test, rollback, and old-image cleanup.

## Updating from upstream

1. Fetch and inspect a signed Immich release tag.
2. Review its release notes, migrations, Compose file, pinned PostgreSQL image,
   Valkey image, machine-learning image, and required tool versions.
3. Merge the upstream tag without removing the project-specific files above.
4. Update the baseline release and commit in this file.
5. Run server, web, and mobile checks before publishing an immutable image tag.

Do not copy secrets into the source tree. Production `.env` and `smoke.env`
files live only on the server with mode `600`.
