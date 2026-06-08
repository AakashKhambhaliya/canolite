# Deploying Canolite

Canolite ships as a **single self-contained container** — in-process database
(PGlite), local-disk storage, and headless-Chromium rendering, all in one image.
You only need to persist two paths and set one env var.

| What | Value |
|------|-------|
| Port | `3000` |
| Health check | `GET /api/health` → `{"status":"ok"}` |
| Persist | `/app/data` (database) and `/app/public/storage` (rendered images + uploads) |
| Required env | `APP_URL` = the public URL of your instance (e.g. `https://canolite.example.com`) |
| Optional env | `ADMIN_EMAIL` + `ADMIN_PASSWORD` (auto-create admin and skip the setup wizard) |

> **Why `APP_URL` matters:** generated image URLs are absolute
> (`$APP_URL/storage/...`). If it's wrong, image links in the dashboard/API break.

**Resources:** rendering launches Chromium, so give it **≥ 1 GB RAM** (2 GB
comfortable). The image is ~1 GB (includes Chromium). On first boot you'll see a
**setup wizard** to create the admin account.

---

## Coolify

1. **New Resource → Application.** Pick your Git repository (or *Public
   Repository* and paste `https://github.com/AakashKhambhaliya/canolite`).
2. **Build Pack: `Dockerfile`.** Coolify auto-detects the `Dockerfile` in the repo root.
3. **Port:** set the exposed port to `3000`.
4. **Persistent Storage** (Storages tab) — add two volume mounts:
   - `/app/data`
   - `/app/public/storage`
5. **Environment variables:**
   - `APP_URL` = `https://your-domain` (your Coolify domain for this app)
   - *(optional)* `ADMIN_EMAIL`, `ADMIN_PASSWORD`
6. **Domain:** assign a domain — Coolify's proxy terminates HTTPS for you.
7. **Deploy.** Open the domain → complete the setup wizard.

> Prefer Compose? Coolify can deploy `docker-compose.yml` directly (Build Pack:
> *Docker Compose*). The volumes and port are already defined in it — just set
> `APP_URL`.

---

## Dokploy

1. **Create → Application**, choose **Provider: Git** and your repo (or a public
   URL).
2. **Build Type: `Dockerfile`.**
3. **Advanced → Volumes / Mounts** — add two persistent mounts:
   - `/app/data`
   - `/app/public/storage`
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
The PGlite database lives in `./.pglite` and images in `./public/storage` — back
those up.

---

## Updating

```bash
git pull
docker compose up -d --build      # Docker
# or: npm install && npm run build && restart your process (non-Docker)
```

Schema migrations run automatically on boot — no manual step.

## Backups

- **Default (PGlite):** back up the `/app/data` and `/app/public/storage` volumes.
- **External Postgres:** back up your Postgres database + the storage volume.
