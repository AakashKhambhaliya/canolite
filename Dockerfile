# ============================================================
# Canolite — production image
#
# Self-contained by default: in-process PGlite database + local filesystem
# storage + headless-Chromium rendering. Mount a single volume at /app/data to
# persist all state. Point DATABASE_URL at Postgres to use Postgres instead.
# ============================================================

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- Dependencies (incl. dev, for building) ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build ----
FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- Runner ----
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATABASE_URL=pglite:///app/data/pglite \
    STORAGE_DIR=/app/data/storage \
    REQUIRE_PERSISTENT_DATA=1

# Production deps, then download Chromium + its system libraries.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

# Build output + runtime assets.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/next.config.mjs ./next.config.mjs

# Writable data dirs (PGlite DB + rendered images / uploads + backups). Mount a
# volume at /app/data to persist everything — the app keeps all state under it.
RUN mkdir -p /app/data/pglite /app/data/storage /app/data/backups

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
