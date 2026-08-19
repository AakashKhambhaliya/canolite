# Deploying Canolite

Canolite ships as a **single self-contained container** — in-process database
(PGlite), local-disk storage, and headless-Chromium rendering, all in one image.
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

Everything is declared in `docker-compose.coolify.yml`: the persistent volume,
the port, and the public URL. There is **nothing to configure in the Storages
tab**, which is the step that is easiest to miss.

1. **New Resource → Application → Public Repository**
2. Repository: `https://github.com/AakashKhambhaliya/canolite`
3. **Build strategy: `Compose`**
4. **Compose file: `docker-compose.coolify.yml`**
5. **Deploy**

That pulls the prebuilt image, so there is no build step and no waiting for
Chromium to download. Coolify creates the `/app/data` volume itself and assigns
a domain; `APP_URL` follows it automatically.

Optionally set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in Coolify's environment panel
to skip the first-run setup wizard.

> **Do not add a `DATABASE_URL` variable** unless you are deliberately pointing
> at a real Postgres server. Blank is worse than absent — an empty value
> overrides the image default and relocates the database into the container.

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
5. **Environment variables:**
   - `APP_URL` = `https://your-domain` (your Coolify domain for this app)
   - *(optional)* `ADMIN_EMAIL`, `ADMIN_PASSWORD`

   > ⚠️ **Never create a `DATABASE_URL` variable.** A *blank* `DATABASE_URL`
   > is worse than none: it overrides the Dockerfile's default
   > (`pglite:///app/data/pglite`) and silently relocates the database into the
   > container's ephemeral layer, wiping your data on every redeploy. If the
   > variable exists at all, **delete it**. (The app also refuses to boot if a
   > blank `DATABASE_URL` is set.)
6. **Domain:** assign a domain — Coolify's proxy terminates HTTPS for you.
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

(Use the included **`docker-compose.full.yml`** instead if you want an external
PostgreSQL: `docker compose -f docker-compose.full.yml up -d --build`.)

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
The PGlite database lives in `./.pglite`, images in `./public/storage` (or in
`STORAGE_DIR` if you set it), and backups in `./.backups` — back those up.

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

- **PGlite (default):** `database.tar.gz` — a restorable tarball of the
  database's data directory, plus a `backup.json` manifest.
- **PostgreSQL:** `database.dump` — a `pg_dump` custom-format dump (requires
  `postgresql-client` in the image; if `pg_dump` is unavailable the backup is
  skipped with a warning).

### Restore

**PGlite (default):**

1. Stop the app (`docker compose down`).
2. Replace the contents of `/app/data/pglite` with the backup. Extract the
   tarball into `/app/data/pglite`:
   ```bash
   tar -xzf database.tar.gz -C /app/data/pglite
   ```
3. Start the app again (`docker compose up -d`).

**PostgreSQL:**

```bash
pg_restore --dbname "$DATABASE_URL" --clean --if-exists database.dump
```

> Always restore the database *and* keep the same `/app/data/storage` contents,
> since template/asset/render rows reference stored files by path.

---

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
| `DATABASE_URL` | `pglite:///app/data/pglite` (Docker) | External PostgreSQL URL, or `pglite://…` for in-process. |

> `GIT_SHA`, `APP_VERSION` are **build args** (not runtime env): the Dockerfile
> and GitHub Actions workflow bake the commit SHA and version into the image,
> which `/api/health` reports.
