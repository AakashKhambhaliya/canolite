# Canolite

**Self-hosted template-to-image and video generation platform.** Design templates in a visual editor, then generate images **and MP4 video** via API. A self-hosted Bannerbear/Templated.io alternative.

![Next.js](https://img.shields.io/badge/Next.js-15-black) ![React](https://img.shields.io/badge/React-19-blue) ![Fabric.js](https://img.shields.io/badge/Fabric.js-6-orange) ![License](https://img.shields.io/badge/License-MIT-green)

> ⚡ **Use it in [n8n](https://n8n.io)** — generate images from your automation workflows with the official community node. In n8n go to **Settings → Community Nodes → Install** and enter [`n8n-nodes-canolite`](https://www.npmjs.com/package/n8n-nodes-canolite). [See setup ↓](#n8n)

---

## Features

- 🎨 **Visual Template Editor** — Fabric.js drag-and-drop editor with text, images, shapes, **video layers**, **layer reordering**, **alignment/snapping guides**, **all Google Fonts + custom font upload**
- 🎬 **Video templates → MP4** — Drop in an MP4/WebM/MOV, trim it, set when it starts, loop and mute it, then export the whole design as H.264 video with every other layer composited on top. ffmpeg ships with the app
- 🔗 **REST API** — Bannerbear-style API for single and batch image **and video** generation
- 🔌 **n8n integration** — Official [community node](https://www.npmjs.com/package/n8n-nodes-canolite) to generate images from your automation workflows
- 📊 **Bulk CSV Import** — Upload a spreadsheet to generate hundreds of images at once
- 🔑 **API Key Management** — Create/revoke keys with secure hashing (shown once)
- 🎯 **Playground** — Interactive template testing with live API request preview
- 📄 **Auto-generated API Docs** — Per-template documentation with copy-paste code examples
- 🪝 **Webhooks** — Get notified when renders complete or fail
- 📈 **Render Logs** — Track, retry, and delete renders
- ⚙️ **Per-project defaults** — Default format/quality/scale + configurable **render retention** with automatic cleanup
- 🔒 **Single-admin auth** — One-time setup wizard, no public sign-up
- 🔄 **Self-update checker** — One-click updates (git self-update, or Coolify redeploy)
- ⚡ **Runs without Docker** — `npm run setup` and it's up: embedded PostgreSQL + local storage, no `.env` and no external services. Or point it at an external **PostgreSQL**

---

## Quick Start

### 🚀 One-command install (VPS, with Docker)

On a fresh VPS, run:

```bash
curl -fsSL https://raw.githubusercontent.com/AakashKhambhaliya/canolite/main/install.sh | bash
```

This installs Docker if needed, fetches Canolite, and starts it. When it
finishes it prints your URL — open it and complete the **setup wizard**.

Point it at a domain (with HTTPS via your own reverse proxy) like so:

```bash
curl -fsSL https://raw.githubusercontent.com/AakashKhambhaliya/canolite/main/install.sh | DOMAIN=canolite.example.com bash
```

### Coolify (one-click)

Paste the repo URL, pick **Compose** as the build strategy and
`docker-compose.coolify.yml` as the file, then deploy. The persistent volume,
port and public URL are all declared in that file — nothing to wire up by hand,
and no build step (it pulls the prebuilt image).

Hosting on **Dokploy**, or want manual Docker/VPS steps? See
**[DEPLOY.md](./DEPLOY.md)**.

### Local development

**Requirements:** Node.js **22+** (Next.js 15). No Docker needed.

```bash
git clone https://github.com/AakashKhambhaliya/canolite.git
cd canolite
npm run setup
```

That single command installs dependencies, downloads the matching headless
Chromium (~150 MB, one time), and starts the server. **No `.env` is needed** —
the database, storage and asset URLs all have working defaults.

Useful flags:

```bash
npm run setup -- --port 3001    # serve on a different port
npm run setup -- --prod         # production build + start instead of dev
npm run setup -- --no-start     # install and verify only
```

Open **http://localhost:3000** — on first launch you'll be guided through a
one-time **setup wizard** to create your admin account. (Image/asset URLs are
relative, so it works on any port without setting `APP_URL`.)

Already set up? `npm run dev` starts the server on its own.

That's it. By default Canolite runs **fully self-contained** with no external
services:

- **Database** → embedded PostgreSQL by default, persisted to `./data/pgdata` locally or `/app/data/pgdata` in Docker
- **Storage** → local filesystem under `public/storage` (or `STORAGE_DIR`)
- **Rendering** → synchronous, in-process (headless Chromium + Sharp, plus bundled ffmpeg for MP4)

Schema migrations run automatically on boot, with an automatic backup taken
before any pending migration. Demo data is only inserted in development (set
`SEED_DEMO_DATA=true` to opt in elsewhere).

### Run with Docker

Prefer containers? The whole app runs in one self-contained image:

```bash
docker compose up -d --build
```

Persist the single `/app/data` volume (database + images + backups), set
`APP_URL` to your public URL, and open the app. Full guides for **Coolify**,
**Dokploy**, and a **bare VPS** are in **[DEPLOY.md](./DEPLOY.md)**.

### Optional: external PostgreSQL

Prefer managed/external Postgres over the embedded default? Set `DATABASE_URL` to a
`postgres://…` URL and Canolite uses it instead (tables are migrated
automatically on boot). Rendered images are still stored on local disk. A ready
compose file is included:

```bash
docker compose -f docker-compose.full.yml up -d --build
```

### Signing in

Canolite is a **single-admin, self-hosted** tool — there's no public sign-up.

On first launch you create the admin account (email + password) in a **one-time
setup wizard**. After that you sign in with those credentials, and can change
the password anytime from **Settings** (it re-verifies your current password).

**Headless / Docker:** set both env vars to auto-provision the admin on boot and
skip the wizard:

```bash
ADMIN_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=your-strong-password
```

---

## Architecture

```
Browser (editor + dashboard)
        │
        ▼
Next.js App  ──┬── Dashboard pages (editor, templates, keys, playground, renders, settings)
               └── API: /api/* (session auth) · /v1/* (API-key auth)
        │
        │  create render job → apply modifications →
        │  render in headless Chromium (Fabric.js) → Sharp post-process → store
        ▼
Render pipeline (synchronous, in-process)
        │
        ├── Image (png/jpg/webp): one Chromium paint → Sharp → store
        │
        ├── Video (mp4): ffmpeg decodes each source clip to frames →
        │     Chromium paints one canvas per output frame →
        │     ffmpeg encodes H.264 + audio → store (job reports progress)
        │
        ├── Database: embedded PostgreSQL (default) or external PostgreSQL
        └── Storage:  local filesystem (persist with a volume)
```

> A BullMQ worker (`src/queue/worker.ts`) is included if you later want an
> out-of-process render queue, but it isn't required — renders run in-process.

---

## API Reference

### Authentication

```bash
Authorization: Bearer sk_live_your_api_key
```

Create keys in the dashboard under **API Keys**.

### Generate a single image

```bash
POST /v1/images
{
  "template_id": "tmpl_abc123",
  "modifications": [
    { "name": "headline", "text": "Hello World" },
    { "name": "photo", "image_url": "https://example.com/img.png" }
  ],
  "format": "png",
  "quality": 90,
  "scale": 2,
  "webhook_url": "https://example.com/webhook"
}
```

Returns `202` with a `uid`; poll for the result:

```bash
GET /v1/images/:uid
```

> `image_url` and `webhook_url` must be **public** http(s) URLs — requests to
> localhost / private IPs are rejected (SSRF protection).

### Generate an MP4 video

Templates containing video layers expose asynchronous MP4 rendering:

```bash
POST /v1/videos
{
  "template_id": "tmpl_abc123",
  "modifications": [
    { "name": "headline", "text": "Launch" },
    { "name": "hero_video", "video_url": "https://example.com/clip.mp4", "trim_start": 0, "trim_end": 8 }
  ],
  "fps": 30,
  "duration": 8,
  "quality": "balanced",
  "webhook_url": "https://example.com/webhook"
}
```

Returns `202`; poll the job for progress and URLs:

```bash
GET /v1/videos/:uid
```

Batch MP4 rendering is available at `POST /v1/videos/batch` and is capped at 20 items.

### Batch generation

```bash
POST /v1/images/batch
{
  "template_id": "tmpl_abc123",
  "format": "jpg",
  "quality": 85,
  "items": [
    { "modifications": [{ "name": "title", "text": "Image 1" }] },
    { "modifications": [{ "name": "title", "text": "Image 2" }] }
  ]
}
```

### List templates

```bash
GET /v1/templates
GET /v1/templates/:template_id
```

---

## Integrations

### n8n

Automate image generation from [n8n](https://n8n.io) workflows using the official
community node — [**n8n-nodes-canolite**](https://www.npmjs.com/package/n8n-nodes-canolite)
([source](https://github.com/AakashKhambhaliya/n8n-nodes-canolite)).

**Install**

1. In n8n, go to **Settings → Community Nodes → Install**.
2. Enter `n8n-nodes-canolite` and confirm.
3. Add the **Canolite** node to any workflow.

**Connect (credentials)**

Create a **Canolite API** credential in n8n with:

| Field    | Value                                             |
|----------|---------------------------------------------------|
| Base URL | Your Canolite instance URL (e.g. `http://localhost:3000`) |
| API Key  | A key from the dashboard under **API Keys** (`sk_live_…`) |

**What you can do**

- **Image → Generate / Generate (Sync)** — render a single image. Pick a **Template ID**
  and the node loads that template's editable objects into a dropdown; each object shows
  just the field it needs (text or image URL). Sync returns the `image_url` directly;
  async can **Wait for Completion** and poll until the render is done.
- **Image → Batch Generate** — render many images from one template in a single request.
- **Image → Get Status** — check a render job by UID.
- **Template → Get / Get Many** — list or fetch templates.

> Requires Canolite **API v1** and n8n **1.0+**.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 15 (App Router) · React 19 |
| Language | TypeScript 5 |
| Editor | Fabric.js 6 — snapping, layer reorder, Google Fonts, custom fonts, video layers |
| Rendering | Synchronous & in-process — headless Chromium (Playwright) + Sharp |
| Video | ffmpeg / ffprobe (bundled) — H.264 + AAC MP4 encoding |
| Database | Embedded PostgreSQL zero-config default · external PostgreSQL for production |
| Storage | Local filesystem (persist with a volume) |
| UI | Tailwind CSS 4 + shadcn/ui + Radix UI |
| Auth | Single-admin, session-based (bcrypt) |

---

## Deployment

Canolite starts an embedded PostgreSQL child process when `DATABASE_URL` is unset, so local and single-container installs work with zero database setup. For production, point `DATABASE_URL` at a managed/external PostgreSQL database.

See **[DEPLOY.md](./DEPLOY.md)** for step-by-step guides for **Coolify**,
**Dokploy**, and a **bare VPS** (with or without Docker).

---

## Environment Variables

If `DATABASE_URL` is unset, Canolite starts embedded PostgreSQL on `127.0.0.1` using `PGDATA_DIR` and `PGPORT`. For production, set `DATABASE_URL` to a managed/external PostgreSQL connection string.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_URL` | `http://localhost:3000` | Public URL of the app. Image/asset URLs are now relative (resolve to the current origin), so this is only needed for **webhook payloads** to carry an absolute image URL. |
| `DATABASE_URL` | unset | External PostgreSQL connection string (`postgres://…` or `postgresql://…`). When unset, embedded PostgreSQL starts on `127.0.0.1`. Production should use managed/external PostgreSQL. |
| `PGDATA_DIR` | `./data/pgdata` | Data directory for embedded PostgreSQL when `DATABASE_URL` is unset. Docker sets `/app/data/pgdata`. |
| `PGPORT` | `54329` | Local loopback port for embedded PostgreSQL. Uses 54329 rather than 5432 to avoid clashing with system Postgres. |
| `DB_POOL_MAX` | `10` | Maximum node-postgres pool connections per process. The web app and `npm run worker` are separate processes and each gets its own pool. |
| `DB_SSL` | auto | For non-local PostgreSQL hosts, SSL is enabled automatically. Set `DB_SSL=disable` only for trusted private networks that do not support SSL. |
| `ADMIN_EMAIL` | — | Optional: auto-provision admin email on boot (skips the setup wizard) |
| `ADMIN_PASSWORD` | — | Optional: auto-provision admin password on boot (skips the setup wizard) |
| `STORAGE_DIR` | `public/storage` | Where rendered output and uploads are written. Docker sets `/app/data/storage`. |
| `BACKUP_DIR` | `./.backups` | Where pre-migration database backups are written. Falls back to `/app/data/backups` automatically when that directory exists (i.e. in Docker). |
| `RENDER_CONCURRENCY` | `3` | Maximum in-process image renders at once |
| `MAX_UPLOAD_MB` | `10` | Max image/font upload file size |
| `MAX_VIDEO_UPLOAD_MB` | `100` | Max video upload size in MB. The request-body limit follows this value, so raising it raises both. |
| `MAX_VIDEO_DURATION_SEC` | `60` | Max uploaded source video duration in seconds |
| `MAX_VIDEO_PIXELS` | `8294400` | Max uploaded source video resolution as width × height pixels |
| `FFMPEG_PATH` / `FFPROBE_PATH` | package binary | Optional absolute paths to ffmpeg/ffprobe executables |
| `VIDEO_RENDER_TIMEOUT_MS` | `900000` | Timeout budget for async MP4 renders |
| `VIDEO_PROBE_TIMEOUT_MS` / `VIDEO_POSTER_TIMEOUT_MS` | `60000` / `60000` | Timeout budget for upload video probing and poster extraction |
| `VIDEO_DEFAULT_FPS` / `VIDEO_MAX_FPS` | `30` / `60` | Default and maximum MP4 render frame rate |
| `VIDEO_MAX_OUTPUT_SEC` | `120` | Maximum MP4 output duration |
| `VIDEO_DECODE_TIMEOUT_MS` | `300000` | Timeout budget for decoding a source clip to frames |
| `VIDEO_CONCURRENCY` | `1` | Maximum in-process video renders at once |

Sessions are random tokens stored in the database, so there is no signing secret
to configure. `AUTH_SECRET` and `NEXTAUTH_URL` still appear in `.env.example`
but are not read anywhere — you can leave them unset.

---

## License

MIT
