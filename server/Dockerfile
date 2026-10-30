FROM ghcr.io/immich-app/base-server-dev:202607132058@sha256:968709a3668167f11ef8ece5962e72ea8a4231e841f98bd5e0f35da4cc295cc7 AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  CI=1 \
  COREPACK_HOME=/tmp \
  PNPM_HOME=/buildcache/pnpm-store \
  PATH="/buildcache/pnpm-store:$PATH"

RUN npm install --global corepack@latest && \
  corepack enable pnpm && \
  pnpm config set store-dir "$PNPM_HOME"

FROM builder AS server

WORKDIR /usr/src/app
COPY ./server ./server/
COPY ./packages/sdk ./packages/sdk/
COPY ./packages/plugin-sdk ./packages/plugin-sdk/
RUN --mount=type=cache,id=pnpm-server,target=/buildcache/pnpm-store \
  --mount=type=bind,source=package.json,target=package.json \
  --mount=type=bind,source=.pnpmfile.cjs,target=.pnpmfile.cjs \
  --mount=type=bind,source=pnpm-lock.yaml,target=pnpm-lock.yaml \
  --mount=type=bind,source=pnpm-workspace.yaml,target=pnpm-workspace.yaml \
  SHARP_IGNORE_GLOBAL_LIBVIPS=true pnpm --filter @immich/sdk --filter @immich/plugin-sdk --filter immich build && \
  SHARP_FORCE_GLOBAL_LIBVIPS=true pnpm --filter immich --prod deploy /output/server-pruned

FROM builder AS web

ARG BUILD_ID
ENV IMMICH_BUILD=${BUILD_ID}

WORKDIR /usr/src/app
COPY ./web ./web/
COPY ./i18n ./i18n/
COPY ./packages ./packages/
RUN --mount=type=cache,id=pnpm-web,target=/buildcache/pnpm-store \
  --mount=type=bind,source=package.json,target=package.json \
  --mount=type=bind,source=.pnpmfile.cjs,target=.pnpmfile.cjs \
  --mount=type=bind,source=pnpm-lock.yaml,target=pnpm-lock.yaml \
  --mount=type=bind,source=pnpm-workspace.yaml,target=pnpm-workspace.yaml \
  SHARP_IGNORE_GLOBAL_LIBVIPS=true pnpm --filter @immich/sdk --filter immich-web install --frozen-lockfile --force && \
  pnpm --filter @immich/sdk --filter immich-web build

FROM builder AS cli

COPY ./packages ./packages/
RUN --mount=type=cache,id=pnpm-cli,target=/buildcache/pnpm-store \
  --mount=type=bind,source=package.json,target=package.json \
  --mount=type=bind,source=.pnpmfile.cjs,target=.pnpmfile.cjs \
  --mount=type=bind,source=pnpm-lock.yaml,target=pnpm-lock.yaml \
  --mount=type=bind,source=pnpm-workspace.yaml,target=pnpm-workspace.yaml \
  pnpm --filter @immich/sdk --filter @immich/cli install --frozen-lockfile && \
  pnpm --filter @immich/sdk --filter @immich/cli build && \
  pnpm --filter @immich/cli --prod --no-optional deploy /output/cli-pruned

FROM ghcr.io/immich-app/base-server-prod:202607132058@sha256:85cca651310842265015f26a6710bb7420a54a8fd1ec22d519b7b620f5f93bb1 AS runtime-base

FROM alpine:3.22.1 AS geonames

ARG GEONAMES_ALTERNATE_NAMES_URL=https://download.geonames.org/export/dump/alternateNamesV2.zip
ARG GEONAMES_ALTERNATE_NAMES_VERSION=2026-07-23
ARG GEONAMES_FILTER_VERSION=city-admin-zh-en-v1

COPY --from=runtime-base /build/geodata/cities500.txt /tmp/geodata/cities500.txt
COPY --from=runtime-base /build/geodata/admin1CodesASCII.txt /tmp/geodata/admin1CodesASCII.txt
COPY --from=runtime-base /build/geodata/admin2Codes.txt /tmp/geodata/admin2Codes.txt
COPY server/resources/filter-geonames-alternate-names.awk /tmp/filter-geonames-alternate-names.awk

RUN apk add --no-cache curl unzip && \
  mkdir -p /output && \
  curl --fail --location --retry 5 --output /tmp/alternateNamesV2.zip "${GEONAMES_ALTERNATE_NAMES_URL}" && \
  unzip -p /tmp/alternateNamesV2.zip alternateNamesV2.txt > /tmp/geodata/alternateNamesV2.txt && \
  awk -f /tmp/filter-geonames-alternate-names.awk \
    /tmp/geodata/cities500.txt \
    /tmp/geodata/admin1CodesASCII.txt \
    /tmp/geodata/admin2Codes.txt \
    /tmp/geodata/alternateNamesV2.txt > /output/alternateNamesV2.txt && \
  test "$(wc -l < /output/alternateNamesV2.txt)" -gt 0 && \
  test "$(wc -c < /output/alternateNamesV2.txt)" -le 10485760 && \
  awk -F '\t' \
    'NF < 8 || ($3 != "zh-CN" && $3 != "zh-Hans" && $3 != "zh" && $3 != "en") || $4 == "" || $8 == "1" { exit 1 }' \
    /output/alternateNamesV2.txt && \
  source_sha256="$(sha256sum /tmp/alternateNamesV2.zip | cut -d ' ' -f 1)" && \
  subset_sha256="$(sha256sum /output/alternateNamesV2.txt | cut -d ' ' -f 1)" && \
  printf '%s %s %s %s\n' \
    "${GEONAMES_ALTERNATE_NAMES_VERSION}" \
    "${source_sha256}" \
    "${GEONAMES_FILTER_VERSION}" \
    "${subset_sha256}" > /output/alternateNamesV2-date.txt && \
  rm /tmp/alternateNamesV2.zip /tmp/geodata/alternateNamesV2.txt

FROM builder AS plugins

ARG TARGETPLATFORM

COPY --from=ghcr.io/jdx/mise:2026.7.2@sha256:51d92371cc08e3c4f0e52f58bb3ec1975a6dc966b7430a4da37dcfc6ae772f30 /usr/local/bin/mise /usr/local/bin/mise

WORKDIR /app
COPY ./mise.toml ./mise.toml
COPY ./packages/plugin-core/mise.toml ./packages/plugin-core/
ENV MISE_TRUSTED_CONFIG_PATHS=/app/mise.toml
ENV MISE_DATA_DIR=/buildcache/mise
ENV MISE_DISABLE_TOOLS=flutter
RUN --mount=type=cache,id=mise-tools-${TARGETPLATFORM},target=/buildcache/mise \
  mise install

COPY ./packages/sdk ./packages/sdk/
COPY ./packages/plugin-core ./packages/plugin-core/
COPY ./packages/plugin-sdk ./packages/plugin-sdk/

# Build plugins
RUN --mount=type=cache,id=pnpm-packages,target=/buildcache/pnpm-store \
  --mount=type=bind,source=package.json,target=package.json \
  --mount=type=bind,source=.pnpmfile.cjs,target=.pnpmfile.cjs \
  --mount=type=bind,source=pnpm-lock.yaml,target=pnpm-lock.yaml \
  --mount=type=bind,source=pnpm-workspace.yaml,target=pnpm-workspace.yaml \
  --mount=type=cache,id=mise-tools-${TARGETPLATFORM},target=/buildcache/mise \
  mise //:plugins

FROM runtime-base

WORKDIR /usr/src/app
ENV NODE_ENV=production \
  NVIDIA_DRIVER_CAPABILITIES=all \
  NVIDIA_VISIBLE_DEVICES=all

COPY --from=server /output/server-pruned ./server
COPY --from=web /usr/src/app/web/build /build/www
COPY --from=cli /output/cli-pruned ./cli
COPY --from=plugins /app/packages/plugin-core/dist /build/plugins/immich-plugin-core/dist
COPY --from=plugins /app/packages/plugin-core/manifest.json /build/plugins/immich-plugin-core/manifest.json
COPY --from=geonames /output/alternateNamesV2.txt /build/geodata/alternateNamesV2.txt
COPY --from=geonames /output/alternateNamesV2-date.txt /build/geodata/alternateNamesV2-date.txt
RUN ln -s ../../cli/bin/immich server/bin/immich
RUN cd server && node -e "require('sqlite-vec').getLoadablePath()"
COPY LICENSE /licenses/LICENSE.txt
COPY server/resources/GEONAMES-LICENSE.txt /licenses/GEONAMES-LICENSE.txt
COPY LICENSE /LICENSE

ENV PATH="${PATH}:/usr/src/app/server/bin"

ARG BUILD_ID
ARG BUILD_IMAGE
ARG BUILD_SOURCE_REF
ARG BUILD_SOURCE_COMMIT

ENV IMMICH_BUILD=${BUILD_ID}
ENV IMMICH_BUILD_URL=https://github.com/immich-app/immich/actions/runs/${BUILD_ID}
ENV IMMICH_BUILD_IMAGE=${BUILD_IMAGE}
ENV IMMICH_BUILD_IMAGE_URL=https://github.com/immich-app/immich/pkgs/container/immich-server
ENV IMMICH_REPOSITORY=immich-app/immich
ENV IMMICH_REPOSITORY_URL=https://github.com/immich-app/immich
ENV IMMICH_SOURCE_REF=${BUILD_SOURCE_REF}
ENV IMMICH_SOURCE_COMMIT=${BUILD_SOURCE_COMMIT}
ENV IMMICH_SOURCE_URL=https://github.com/immich-app/immich/commit/${BUILD_SOURCE_COMMIT}

VOLUME /data
EXPOSE 2283
ENTRYPOINT ["tini", "--", "/bin/bash", "-c"]
CMD ["start.sh"]

HEALTHCHECK CMD immich-healthcheck
