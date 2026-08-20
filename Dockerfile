# ============================================================
# Canolite — production image
#
# Self-contained by default: embedded PostgreSQL + local filesystem storage +
# headless-Chromium rendering. Mount a single volume at /app/data to persist all
# state. Point DATABASE_URL at external Postgres to bypass embedded Postgres.
# ============================================================

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- Dependencies (incl. dev, for building) ----
FROM base AS deps
# This stage only compiles the app — it never renders, so skip the browser
# download the postinstall hook would otherwise do here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm ci

# ---- Build ----
FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- Runner ----
FROM base AS runner

# Build-time identity. Coolify passes SOURCE_COMMIT automatically; the GHCR
# workflow passes GIT_SHA/APP_VERSION explicitly. GIT_SHA falls back to
# SOURCE_COMMIT, and both fall back to "unknown".
ARG SOURCE_COMMIT=unknown
ARG GIT_SHA=${SOURCE_COMMIT}
ARG APP_VERSION

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PGDATA_DIR=/app/data/pgdata \
    PGPORT=54329 \
    STORAGE_DIR=/app/data/storage \
    REQUIRE_PERSISTENT_DATA=1 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    GIT_SHA=${GIT_SHA} \
    APP_VERSION=${APP_VERSION}

# Production deps, then download Chromium + its system libraries.
# scripts/ must land before `npm ci` — the postinstall hook lives there and npm
# runs it as part of the install. ffmpeg/ffprobe are installed via apt so the
# image does not depend on npm postinstall binary downloads at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

# Build output + runtime assets.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/next.config.mjs ./next.config.mjs

# Writable data dirs (embedded PostgreSQL + rendered images / uploads + backups).
# Mount a volume at /app/data to persist everything — the app keeps all state
# under it. PostgreSQL refuses to run as root, so the runtime user is non-root.
RUN groupadd -r canolite \
 && useradd -r -g canolite -d /app -s /usr/sbin/nologin canolite \
 && mkdir -p /app/data/pgdata /app/data/storage /app/data/backups \
 && chown -R canolite:canolite /app/data

# Record when this image was built (reported by /api/health as buildTime).
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > /app/.build-time
USER canolite

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
