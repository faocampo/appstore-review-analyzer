# syntax=docker/dockerfile:1.7
#
# ReviewSignal: one image, three server processes plus the Next.js panels.
# See docs/service-contract.md. The command selects the process:
#
#   API         node dist/server/api.js       (port 8080)
#   Worker      node dist/server/worker.js    (metrics port 9464)
#   Migrations  node dist/server/migrate.js   (one-shot, exit 0 on success)
#   Web         node_modules/.bin/next start  (port 3000, dev/demo harness)
#
# Pin NODE_IMAGE to a digest in CI (node:24-slim@sha256:...) for reproducible
# builds; the tag below is the floating Node 24 LTS slim image.

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------
# base: shared settings
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: full dependency tree for the build
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

# ---------------------------------------------------------------------------
# build: Next.js panels and the tsup server bundles
# ---------------------------------------------------------------------------
FROM deps AS build
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time.
# Only the web harness uses it; the API, worker and migrations ignore it.
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY . .
# Migrations are TypeScript modules bundled into dist/server/migrate.js, so
# no separate SQL files ship with the image.
RUN npm run build \
 && npm run build:server \
 && test -f dist/server/api.js \
 && test -f dist/server/worker.js \
 && test -f dist/server/migrate.js \
 && rm -rf .next/cache

# ---------------------------------------------------------------------------
# prod-deps: runtime dependencies only
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --legacy-peer-deps --ignore-scripts

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini forwards SIGTERM to Node and reaps zombies (Node runs as PID 1 otherwise).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    METRICS_PORT=9464
WORKDIR /app

# Application files are owned by root and read-only for the runtime user.
# .next is owned by `node` so the web harness can write its cache when the
# root filesystem is writable (local compose); Kubernetes mounts /tmp only.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/next.config.ts /app/tsconfig.json ./

# The base image's `node` user (uid/gid 1000). Kubernetes enforces the same
# numeric ids through runAsUser/runAsGroup.
USER 1000:1000

EXPOSE 8080 9464 3000

# No HEALTHCHECK: Kubernetes probes (/healthz, /readyz) and the compose file
# define health checks per process.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/api.js"]
