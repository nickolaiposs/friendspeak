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

# The base image is pinned by digest, on every FROM line: a tag can be moved, a digest can't.
# Dependabot (.github/dependabot.yml) opens a PR when node:24-bookworm-slim has a newer one;
# by hand: `docker buildx imagetools inspect node:24-bookworm-slim` and replace all three.

# ---------------------------------------------------------------- build the game
# The build output is plain JS, so build once on the native platform even for
# multi-arch images (no slow emulated webpack run for arm64).
FROM --platform=$BUILDPLATFORM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
# --ignore-scripts: skip the Electron download and the postinstall game build
# (sources aren't copied yet); the game is built explicitly below.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY game ./game
COPY scripts ./scripts
RUN npm run build:game

# ---------------------------------------------------------------- runtime dependencies
# Installed for the target platform in a stage of their own, so the runtime image needs no npm.
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf node_modules/phaser/src node_modules/phaser/types node_modules/phaser/plugins node_modules/@mediapipe

# ---------------------------------------------------------------- runtime
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
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

# The server only needs node. npm, npx, corepack and yarn come with the base image and carry
# packages of their own that scanners (rightly) flag; nothing here runs them. The base's Debian
# packages get the fixes published since the base image was built. Debian's setuid programs (su,
# mount, passwd, ...) lose that bit, after the upgrade so a replaced one loses it too: the server
# runs as `node` and nothing in here should be able to become root.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules

COPY server.js updater.js admin.js logbuffer.js crashlog.js persist.js ./
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
