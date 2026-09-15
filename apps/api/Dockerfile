# syntax=docker/dockerfile:1
#
# The Symplist api image for Render's Docker runtime (architecture §2.2 (2); research "Backend").
# Build from the repository root, which is the build context:
#   docker build --file apps/api/Dockerfile --tag symplist-api .
# The image never receives secrets at build time: Render passes environment variables as build
# arguments, so this file declares no ARG that a secret could fill. Configuration is read at startup.

FROM node:24.21.0-trixie-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /repo
# pnpm 12.4.2 from package.json's packageManager field, through Corepack.
RUN corepack enable pnpm && corepack install --global pnpm@12.4.2
COPY . .
# The api and the workspace packages it depends on, dev dependencies included for the build.
RUN pnpm install --frozen-lockfile --filter "@symplist/api..."
# tsc -b: the api's project references build every workspace package it imports first.
RUN pnpm --filter @symplist/api build
# Production dependencies and the injected workspace packages only (their `files`: dist, migrations).
RUN pnpm --filter @symplist/api --prod deploy /app \
  && node scripts/prune-api-deploy.mjs /app

FROM node:24.21.0-trixie-slim AS runtime
# Git for the document Git service (§9.1), tini as PID 1 for standard signal handling, and CA
# certificates for the D1, R2, Resend, Composio and PostHog APIs.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system symplist \
  && useradd --system --gid symplist --home-dir /nonexistent --no-create-home \
    --shell /usr/sbin/nologin symplist
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
# Owned by root and read-only to the service user, which only needs its temporary Git directory.
COPY --from=build /app /app
USER symplist
# The api listens on PORT; Render sets its own value, and 4000 is the local default (§16.3).
EXPOSE 4000
# tini is PID 1 itself: the base image's docker-entrypoint.sh wrapper is cleared.
ENTRYPOINT []
CMD ["tini", "--", "node", "dist/main.js"]
