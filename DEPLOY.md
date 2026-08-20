# Deploying Canolite

Canolite ships as a **single self-contained container** — embedded PostgreSQL database, local-disk storage, and headless-Chromium rendering, all in one image.
All state (database, rendered images, uploads, backups) lives under **one path**,
so you persist exactly one volume.

| What | Value |
|------|-------|
| Port | `3000` |
| Health check | `GET /api/health` → `{"status":"ok","version":…,"commit":…,"buildTime":…}` |
| Persist | `/app/data` (database + rendered images + uploads + backups) |
| Required env | `APP_URL` = the public URL of your instance (e.g. `https://canolite.example.com`) |
| Optional env | `ADMIN_EMAIL` + `ADMIN_PASSWORD` (auto-create admin and skip the setup wizard) |

> **Why `APP_URL` matters:** generated image URLs are absolute
> (`$APP_URL/storage/...`). If it's wrong, image links in the dashboard/API break.

**Resources:** rendering launches Chromium, so give it **≥ 1 GB RAM** (2 GB
comfortable). The image is ~1 GB (includes Chromium). On first boot you'll see a
**setup wizard** to create the admin account.

---

## Prebuilt image (GHCR)

A prebuilt `linux/amd64` image is published on every push to `main`:

```
ghcr.io/aakashkhambhaliya/canolite:latest
```

The compose files and the installer use it automatically (falling back to a
source build on other architectures or if it's unavailable). Run it directly
with plain Docker:

```bash
docker run -d --name canolite -p 3000:3000 \
  -e APP_URL=https://canolite.example.com \
  -v canolite_data:/app/data \
  ghcr.io/aakashkhambhaliya/canolite:latest
```

> **One-time:** after the first GitHub Actions build, make the package **public**
> (GitHub → Packages → `canolite` → Package settings → Change visibility →
> Public) so it can be pulled without authentication.

---

## Coolify — one-click (recommended)

For production, create a Coolify PostgreSQL resource and point Canolite at it.
Embedded PostgreSQL is the zero-config default, but production Coolify installs should use a managed Coolify PostgreSQL resource so backups and scaling are handled by the platform.

1. **New Resource → Database → PostgreSQL.** Enable scheduled backups on the
   database resource.
2. Copy the PostgreSQL **internal** connection string.
3. **New Resource → Application → Public Repository**
4. Repository: `https://github.com/AakashKhambhaliya/canolite`
5. **Build strategy: `Compose`**
6. **Compose file: `docker-compose.coolify.yml`**
7. Set environment variables on the app:
   - `DATABASE_URL` = the internal PostgreSQL connection string from step 2
   - `DB_POOL_MAX` = `10` (adjust per instance size)
   - `DB_SSL` = `disable` for Coolify's private internal Postgres network unless your database requires TLS
   - `APP_URL` = your Coolify domain if Coolify does not inject it automatically
8. **Deploy**

That pulls the prebuilt image, so there is no build step and no waiting for
Chromium to download. Coolify creates the `/app/data` volume itself and assigns
a domain; `APP_URL` follows it automatically when supported.

Optionally set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in Coolify's environment panel
to skip the first-run setup wizard.

> **Do not leave `DATABASE_URL` blank.** Blank is worse than absent — it
> overrides image defaults and can relocate data into the container. For
> production, set it to PostgreSQL. If omitted, Canolite starts embedded PostgreSQL under `/app/data/pgdata`.

---

## Coolify — building from source

Use this if you want Coolify to rebuild the image from the repository on every
deploy, rather than pulling the published one.

1. **New Resource → Application.** Pick your Git repository (or *Public
   Repository* and paste `https://github.com/AakashKhambhaliya/canolite`).
2. **Build Pack: `Dockerfile`.** Coolify auto-detects the `Dockerfile` in the repo root.

   > ⚠️ **This must be `Dockerfile`.** Coolify's *Build strategy* dropdown
   > defaults to **Railpack** (older versions: **Nixpacks**), and neither uses
   > the `Dockerfile` in this repo. They *will* build and start successfully —
   > the app boots, passes its health check and serves the dashboard — and then
   > every render fails with:
   >
   > ```
   > browserType.launch: Executable doesn't exist at
   > /root/.cache/ms-playwright/chromium_headless_shell-<build>/...
   > ```
   >
   > Only the Dockerfile installs headless Chromium and its system libraries.
   > The `/root/.cache` prefix is how you recognise the mistake: the image sets
   > `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, so any path under `/root/.cache`
   > proves the Dockerfile wasn't used.
   >
   > **Set the `/app/data` volume (step 4) before switching**, or the first
   > Dockerfile deploy will refuse to boot and roll back — the image enables the
   > persistence guard, and that is the guard working, not a broken build.
3. **Port:** set the exposed port to `3000`.
4. **Persistent Storage** (Storages tab) — add **one** volume mount:
   - `/app/data`
5. **PostgreSQL:** create a Coolify PostgreSQL resource, enable backups, and copy
   its internal connection string.
6. **Environment variables:**
   - `DATABASE_URL` = the PostgreSQL internal connection string
   - `DB_POOL_MAX` = `10` (adjust per instance size)
   - `DB_SSL` = `disable` for Coolify's private internal Postgres network unless your database requires TLS
   - `APP_URL` = `https://your-domain` (your Coolify domain for this app)
   - *(optional)* `ADMIN_EMAIL`, `ADMIN_PASSWORD`

   > ⚠️ **Never leave `DATABASE_URL` blank.** A blank variable is worse than
   > absent: it overrides image defaults and can relocate data into the
   > container's ephemeral layer. Production should set `DATABASE_URL` to
   > PostgreSQL. If omitted, Canolite starts embedded PostgreSQL under `/app/data/pgdata`.
7. **Domain:** assign a domain — Coolify's proxy terminates HTTPS for you.
7. **Deploy.** Open the domain → complete the setup wizard.

> Prefer Compose? Coolify can deploy `docker-compose.yml` directly (Build Pack:
> *Docker Compose*). The volume and port are already defined in it — just set
> `APP_URL`.

### Enabling in-app updates (Coolify)

To turn on the one-click **Update now** button (Task 5/6), set three
server-side-only environment variables. They are never sent to the browser.

1. **Create an API token:** Coolify → **Keys & Tokens** → *Create new token*.
   Give it a descriptive name (e.g. `canolite-deploy`) and **scope it to the
   `deploy` permission only**. Copy the token — it is shown once.
2. **Find your app's UUID:** open the application's **Settings** page, look for
   the deploy webhook URL. The UUID is the identifier in that URL (e.g.
   `https://coolify.example.com/api/v1/deploy?uuid=…`). It's also in the app's
   **General** settings.
3. Add the three variables to the application's environment:
   - `COOLIFY_URL` = your Coolify base URL (e.g. `https://coolify.example.com`)
   - `COOLIFY_API_TOKEN` = the deploy-scoped token from step 1
   - `COOLIFY_APP_UUID` = the UUID from step 2
4. Redeploy so the variables take effect.

> 🔒 **Security:** each customer instance must use its **own** token and UUID.
> A shared token would let the admin of any one instance redeploy *every other*
> customer's app.

### Migrating from the old two-mount layout

If you previously mounted both `/app/data` and `/app/public/storage`, do this
once:

1. Keep `/app/public/storage` mounted **for one deploy** (alongside `/app/data`).
2. Deploy. On boot the app copies the old files from `/app/public/storage` into
   `/app/data/storage` automatically and logs what it moved.
3. Remove the `/app/public/storage` mount and redeploy. Done.

---

## Dokploy

1. **Create → Application**, choose **Provider: Git** and your repo (or a public
   URL).
2. **Build Type: `Dockerfile`.**
3. **Advanced → Volumes / Mounts** — add **one** persistent mount:
   - `/app/data`
4. **Environment:** `APP_URL=https://your-domain` (+ optional admin vars).
5. **Domains:** add your domain, container port `3000` (Dokploy/Traefik handles TLS).
6. **Deploy** → open the domain → setup wizard.

> Or use Dokploy's **Compose** service type pointed at `docker-compose.yml`.

---

## Bare VPS — with Docker (recommended)

```bash
git clone https://github.com/AakashKhambhaliya/canolite.git
cd canolite

# Set APP_URL (edit docker-compose.yml, or export it):
export APP_URL=https://canolite.example.com

docker compose up -d --build
```

The app listens on `:3000`. Put a reverse proxy in front for HTTPS — e.g. Caddy:

```caddyfile
canolite.example.com {
    reverse_proxy localhost:3000
}
```

For production with bundled Postgres, use the included **`docker-compose.full.yml`**:

```bash
docker compose -f docker-compose.full.yml up -d --build
```

That compose file runs a `postgres:16-alpine` service, wires Canolite with
`DATABASE_URL=postgres://canolite:canolite@postgres:5432/canolite`, and keeps
Postgres data in the `postgres_data` volume. Enable host-level or provider-level
backups for that volume.

---

## Bare VPS — without Docker (Node 18+)

```bash
git clone https://github.com/AakashKhambhaliya/canolite.git
cd canolite
npm install
npx playwright install --with-deps chromium   # Chromium + system libs
npm run build

APP_URL=https://canolite.example.com PORT=3000 npm run start
```

Keep it running with **pm2** or a **systemd** unit, and reverse-proxy for TLS.
The embedded PostgreSQL database lives in `./data/pgdata`, images in `./public/storage` (or in `STORAGE_DIR` if you set it), and backups in `./.backups` — back those up.

---

## Updating

Updates follow one of three modes, auto-detected at runtime:

| Mode | When | How you update |
|------|------|----------------|
| **coolify** | `COOLIFY_URL` + `COOLIFY_API_TOKEN` + `COOLIFY_APP_UUID` are all set | The in-app **Update now** button asks Coolify to redeploy the app. Coolify rebuilds the image and reattaches the same `/app/data` volume. |
| **git** | There's a `.git` checkout (bare VPS / pm2) | The in-app button runs `git pull → npm install → npm run build → restart`. |
| **none** | Anything else (plain Docker, no Coolify vars) | Updates are managed by the host: `docker compose pull && docker compose up -d` (or re-run `install.sh`). |

The dashboard shows which mode you're in. In **none** mode the button is hidden
and it shows *"Updates are managed by your host."*

Schema migrations run automatically on boot — no manual step. A backup is taken
automatically before any migration is applied.

---

## Backups & Restore

### Automatic

- **Before a migration:** on boot, if the app detects pending schema migrations,
  it writes a backup to `/app/data/backups/<reason>-<version>-<ISO timestamp>/`
  before applying them. It keeps the 5 most recent and prunes older ones.
- **Before an update:** the in-app updater triggers a backup (`pre-update`)
  before it changes anything.

### Manual

```bash
# inside the container (or `docker compose exec canolite sh`)
npm run db:backup
```

### What's in a backup

- **PostgreSQL / embedded PostgreSQL:** `database.dump` — a `pg_dump` custom-format dump (requires
  `postgresql-client` in the image; if `pg_dump` is unavailable the backup is
  skipped with a warning).

### Restore

**PostgreSQL:**

```bash
pg_restore --dbname "$DATABASE_URL" --clean --if-exists database.dump
```

> Always restore the database *and* keep the same `/app/data/storage` contents,
> since template/asset/render rows reference stored files by path.

---

## External PostgreSQL

Use external PostgreSQL for production. Canolite keeps the PostgreSQL dialect
schema (`jsonb`, `uuid().defaultRandom()`, arrays) and runs Drizzle migrations at
boot behind a Postgres advisory lock so multiple app instances do not migrate at
once.

Minimum setup:

```bash
export DATABASE_URL='postgres://user:password@host:5432/canolite'
export DB_POOL_MAX=10
# Optional: only for trusted private networks that do not support TLS
# export DB_SSL=disable
```

For non-local hosts, SSL is enabled automatically unless `DB_SSL=disable` is set.
The web app process and `npm run worker` are separate OS processes, so each one
creates and owns its own node-postgres pool.

When `DATABASE_URL` is unset, Canolite starts embedded PostgreSQL on `127.0.0.1` using `PGDATA_DIR` and `PGPORT`. For production, prefer a managed/external PostgreSQL service and set `DATABASE_URL`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_DIR` | `public/storage` | Root for rendered images and uploads (Docker sets `/app/data/storage`). |
| `REQUIRE_PERSISTENT_DATA` | unset (`1` in Docker) | Refuse to boot if `/app/data` isn't a mounted volume. |
| `SEED_DEMO_DATA` | `false` in production | Whether to insert the demo "Dealer Poster" template on a fresh DB. |
| `COOLIFY_URL` | — | Base URL of the Coolify instance. |
| `COOLIFY_API_TOKEN` | — | Deploy-scoped API token (server-side only — never `NEXT_PUBLIC_`). |
| `COOLIFY_APP_UUID` | — | This application's Coolify resource UUID. |
| `BACKUP_DIR` | `/app/data/backups` (`.backups` without Docker) | Where automatic backups are written. |
| `APP_URL` | `http://localhost:3000` | Public base URL used to build absolute image URLs. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Recovery net: auto-provision the admin on boot if the DB is empty. |
| `DATABASE_URL` | unset | External PostgreSQL URL. When unset, embedded PostgreSQL starts on `127.0.0.1`. Production should use managed/external PostgreSQL. |
| `PGDATA_DIR` | `./data/pgdata` (`/app/data/pgdata` in Docker) | Data directory for embedded PostgreSQL. |
| `PGPORT` | `54329` | Local loopback port for embedded PostgreSQL. |
| `DB_POOL_MAX` | `10` | Maximum node-postgres pool connections per process. The app and worker each get their own pool. |
| `DB_SSL` | auto | SSL is enabled automatically for non-local PostgreSQL hosts. Set `DB_SSL=disable` only on trusted private networks that do not support TLS. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `/usr/bin/ffmpeg` / `/usr/bin/ffprobe` in Docker | Required for video upload probing, poster extraction, and MP4 rendering. Non-Docker installs should install ffmpeg (adds roughly 80 MB) or set these to valid binaries. |
| `MAX_VIDEO_UPLOAD_MB` | `100` | Max video upload size in MB. |
| `MAX_VIDEO_DURATION_SEC` | `60` | Max uploaded source video duration in seconds. |
| `MAX_VIDEO_PIXELS` | `8294400` | Max uploaded source video resolution as width × height pixels. |
| `VIDEO_RENDER_TIMEOUT_MS` | `900000` | Timeout budget for async MP4 renders. |
| `VIDEO_PROBE_TIMEOUT_MS` / `VIDEO_POSTER_TIMEOUT_MS` | `60000` / `60000` | Timeout budget for upload video probing and poster extraction |
| `VIDEO_DEFAULT_FPS` / `VIDEO_MAX_FPS` | `30` / `60` | Default and maximum MP4 render frame rate. |
| `VIDEO_MAX_OUTPUT_SEC` | `120` | Maximum MP4 output duration. |
| `VIDEO_CONCURRENCY` | `1` | Maximum in-process video renders at once. |

> `GIT_SHA`, `APP_VERSION` are **build args** (not runtime env): the Dockerfile
> and GitHub Actions workflow bake the commit SHA and version into the image,
> which `/api/health` reports.
