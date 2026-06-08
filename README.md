# Canolite

**Self-hosted template-to-image generation platform.** Design templates in a visual editor, generate images via API. A self-hosted Bannerbear/Templated.io alternative.

![Next.js](https://img.shields.io/badge/Next.js-14.2-black) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue) ![Fabric.js](https://img.shields.io/badge/Fabric.js-5.3-orange) ![License](https://img.shields.io/badge/License-MIT-green)

---

## Features

- 🎨 **Visual Template Editor** — Fabric.js drag-and-drop editor with text, images, shapes, **layer reordering**, **alignment/snapping guides**, **all Google Fonts + custom font upload**
- 🔗 **REST API** — Bannerbear-style API for single and batch image generation
- 📊 **Bulk CSV Import** — Upload a spreadsheet to generate hundreds of images at once
- 🔑 **API Key Management** — Create/revoke keys with secure hashing (shown once)
- 🎯 **Playground** — Interactive template testing with live API request preview
- 📄 **Auto-generated API Docs** — Per-template documentation with copy-paste code examples
- 🪝 **Webhooks** — Get notified when renders complete or fail
- 📈 **Render Logs** — Track, retry, and delete renders
- 🔒 **Single-admin auth** — One-time setup wizard, no public sign-up
- ⚡ **Runs without Docker** — Self-contained on plain Node (in-process DB + local storage), or scale out with Postgres/Redis/MinIO

---

## Quick Start

**Requirements:** Node.js 18+ (no Docker needed for the default setup).

```bash
# Clone
git clone https://github.com/AakashKhambhaliya/canolite.git
cd canolite

# Install dependencies
npm install

# Install the headless browser used for rendering (~150 MB, one time)
npx playwright install chromium

# Start the app
npm run dev
```

Open **http://localhost:3000** — on first launch you'll be guided through a
one-time **setup wizard** to create your admin account.

That's it. By default Canolite runs **fully self-contained** with no external
services:

- **Database** → in-process [PGlite](https://pglite.dev) (WASM Postgres), persisted to `./.pglite`
- **Storage** → local filesystem under `public/storage`
- **Rendering** → synchronous, in-process (headless Chromium + Sharp)

Schema migration and demo data are applied automatically on first boot.

### Optional: full stack (Postgres + Redis + MinIO)

For production / horizontal scaling, point Canolite at real infrastructure via
Docker Compose:

```bash
# Start infrastructure
docker compose up -d postgres redis minio

# Configure: set DATABASE_URL (postgres://…), and optionally REDIS_URL + S3_*
cp .env.example .env

# Create tables
npm run db:push

# Run the app (+ a queue worker if you use Redis/BullMQ)
npm run dev
npm run worker   # optional — only needed for the Redis/BullMQ render queue
```

When `DATABASE_URL` is a `postgres://…` URL, Canolite uses Postgres instead of
PGlite. Storage falls back to local files unless S3 vars are set.

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
        ├── Database: PGlite (default) or PostgreSQL
        └── Storage:  local filesystem (default) or S3 / MinIO

Optional: Redis + BullMQ worker (npm run worker) for an out-of-process queue.
```

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

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript 5.7 |
| Editor | Fabric.js 5.3 — snapping, layer reorder, Google Fonts, custom fonts |
| Rendering | Headless Chromium (Playwright) + Sharp |
| Database | In-process PGlite by default · PostgreSQL + Drizzle ORM |
| Storage | Local filesystem by default · S3 / MinIO compatible |
| Queue | Synchronous in-process by default · optional Redis + BullMQ |
| UI | Tailwind CSS + shadcn/ui + Radix UI |
| Auth | Single-admin, session-based (bcrypt) |

---

## Environment Variables

All variables are optional for the default self-contained setup.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `pglite://.pglite` | Postgres connection string. Unset or `pglite://…` → in-process PGlite |
| `ADMIN_EMAIL` | — | Optional: auto-provision admin email on boot (skips the setup wizard) |
| `ADMIN_PASSWORD` | — | Optional: auto-provision admin password on boot (skips the setup wizard) |
| `AUTH_SECRET` | — | Session signing secret |
| `APP_URL` | `http://localhost:3000` | Public URL of the app (used in stored image URLs) |
| `RENDER_CONCURRENCY` | `3` | Max concurrent renders (BullMQ worker) |
| `MAX_UPLOAD_MB` | `10` | Max upload file size |
| `REDIS_URL` | `redis://localhost:6379` | Only for the optional BullMQ worker |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_REGION` / `S3_FORCE_PATH_STYLE` | — | Only for S3/MinIO storage (otherwise local filesystem) |

---

## License

MIT
