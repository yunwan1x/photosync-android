#!/bin/sh
set -eu

python -m immich_ml.model_cache sync \
  --seed-root "${IMMICH_ML_MODEL_SEED_FOLDER:-/opt/immich-model-seed}" \
  --cache-root "${MACHINE_LEARNING_CACHE_FOLDER:-/cache}"

exec "$@"
