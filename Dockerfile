# friendspeak server image: chat, voice signaling and the penguin game worlds on one port.
#
#   docker build -t friendspeak .
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/friendspeak:1.1.0 --push .
#
# Releases are built and pushed to ghcr.io/nickolaiposs/friendspeak by
# .github/workflows/release.yml on every push to `prod` (D29).
#
# The game asset pack is NOT part of the image (third-party art, ~3.4 GB).
# Mount it at runtime; see docker-compose.yaml.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------- build the game
# The build output is plain JS, so build once on the native platform even for
# multi-arch images (no slow emulated webpack run for arm64).
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
# --ignore-scripts: skip the Electron download and the postinstall game build
# (sources aren't copied yet); the game is built explicitly below.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY game ./game
COPY scripts ./scripts
RUN npm run build:game

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source=https://github.com/nickolaiposs/friendspeak
WORKDIR /app
# FRIENDSPEAK_DOCKER: AUTO_UPDATE=on is only allowed here, where a Watchtower
# sidecar can replace the container (updater.js).
# ADMIN_LOCAL=off: inside a container, loopback is never the admin's own machine
# (with host networking or a proxy it could be anyone), so the admin dashboard
# always asks for a key (admin.js, D34).
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    FRIENDSPEAK_DOCKER=1 \
    ADMIN_LOCAL=off

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force \
    && rm -rf node_modules/phaser/src node_modules/phaser/types node_modules/phaser/plugins

COPY server.js updater.js admin.js logbuffer.js ./
COPY admin-ui ./admin-ui
COPY public/js/util.js ./public/js/util.js
COPY docker/healthcheck.js ./docker/healthcheck.js
COPY game/index.js ./game/index.js
COPY game/server/data ./game/server/data
COPY game/server/schema.sqlite.sql game/server/LICENSE ./game/server/
COPY game/client/LICENSE ./game/client/
COPY --from=build /app/game/server/dist ./game/server/dist
COPY --from=build /app/game/client/dist ./game/client/dist
COPY --from=build /app/game/client/assets ./game/client/assets

# Mount points for the (optional) asset packs, and the persistent data dir
RUN mkdir -p /data game/assets-pack game/assets-extra && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "docker/healthcheck.js"]
CMD ["node", "server.js"]
