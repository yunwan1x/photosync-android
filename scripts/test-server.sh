#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

BASE_IMAGE="ghcr.io/immich-app/base-server-dev:202607132058@sha256:968709a3668167f11ef8ece5962e72ea8a4231e841f98bd5e0f35da4cc295cc7"

if ! command -v mise >/dev/null 2>&1; then
  echo "mise is required; install the version manager declared by mise.toml" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the server test environment" >&2
  exit 1
fi

mise install --locked

# Immich's plugin compiler requires a newer glibc than some build hosts provide.
# Run the checks in the same pinned base image used by server/Dockerfile.
docker run --rm \
  --volume "${ROOT_DIR}:/workspace" \
  --volume "$(command -v mise):/usr/local/bin/mise:ro" \
  --volume "${HOME}/.local/share/mise:/root/.local/share/mise" \
  --volume "${HOME}/.cache/mise:/root/.cache/mise" \
  --workdir /workspace \
  --env CI=1 \
  --env MISE_TRUSTED_CONFIG_PATHS=/workspace \
  "${BASE_IMAGE}" \
  bash -lc 'mise //server:ci-unit'
