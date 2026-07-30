# Lightweight single-container Immich build.
# - External PostgreSQL (configured via first-run setup wizard at /api/setup/db,
#   or via DB_URL / DB_HOSTNAME env vars; persisted to /data/db-config.json)
# - In-process job queue (no Redis)
# - Local Tesseract OCR (no machine-learning container)
# - Local or S3 image storage
# - Face recognition / CLIP search / video transcoding removed
# Listens on port 7860.

# ---- Builder stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ENV CI=1 \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  PNPM_HOME=/buildcache/pnpm-store \
  PATH="/buildcache/pnpm-store:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable pnpm \
  && pnpm config set store-dir "$PNPM_HOME"

WORKDIR /usr/src/app

# Copy workspace manifests first for better layer caching. .npmrc MUST be
# present before `pnpm install` so node-linker=hoisted takes effect (without
# it pnpm uses the isolated linker and @immich/plugin-sdk's esbuild cannot
# resolve @immich/sdk's build/ output).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc .pnpmfile.cjs ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/plugin-core/package.json ./packages/plugin-core/package.json

RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store \
  pnpm install --frozen-lockfile

# Copy source for the packages that need building.
COPY packages/sdk ./packages/sdk
COPY packages/plugin-sdk ./packages/plugin-sdk
COPY server ./server
COPY web ./web
COPY i18n ./i18n

# Build internal packages, then server, then web.
# @immich/sdk must finish before @immich/plugin-sdk: plugin-sdk's esbuild
# imports @immich/sdk at bundle time. pnpm runs workspace deps in topological
# order, but chaining explicitly here avoids races under the GHA build cache.
RUN pnpm --filter @immich/sdk build \
  && pnpm --filter @immich/plugin-sdk build \
  && pnpm --filter immich build \
  && pnpm --filter immich-web build

# Produce a pruned, production-only server deployment.
# Note: do NOT pass --no-optional — sharp's platform-specific native binaries
# (@img/sharp-linux-x64 / @img/sharp-linux-arm64) ship as optional deps and
# are required since this image does not bundle a global libvips.
RUN pnpm --filter immich --prod deploy /output/server-pruned

# ---- Runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-chi-sim \
    ffmpeg \
    ca-certificates \
    tini \
    file \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

ENV NODE_ENV=production \
  IMMICH_PORT=7860 \
  IMMICH_HOST=0.0.0.0 \
  TESSERACT_PATH=tesseract \
  TESSERACT_LANG=eng \
  IMMICH_IGNORE_MOUNT_CHECK_ERRORS=true

# Server (built artifacts + pruned prod node_modules)
COPY --from=builder /output/server-pruned ./server
# Static web build served by the API process
COPY --from=builder /usr/src/app/web/build /build/www

COPY LICENSE /licenses/LICENSE.txt
COPY LICENSE /LICENSE

ENV PATH="${PATH}:/usr/src/app/server/bin"

VOLUME /data
EXPOSE 7860

ENTRYPOINT ["tini", "--"]
CMD ["node", "/usr/src/app/server/dist/main.js"]
