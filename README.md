# Canolite

**Self-hosted template-to-image generation platform.** Design templates in a visual editor, generate images via API. A self-hosted Bannerbear/Templated.io alternative.

![Next.js](https://img.shields.io/badge/Next.js-15-black) ![React](https://img.shields.io/badge/React-19-blue) ![Fabric.js](https://img.shields.io/badge/Fabric.js-6-orange) ![License](https://img.shields.io/badge/License-MIT-green)

---

## Features

- 🎨 **Visual Template Editor** — Fabric.js drag-and-drop editor with text, images, shapes, **layer reordering**, **alignment/snapping guides**, **all Google Fonts + custom font upload**
- 🔗 **REST API** — Bannerbear-style API for single and batch image generation
- 🔌 **n8n integration** — Official [community node](https://www.npmjs.com/package/n8n-nodes-canolite) to generate images from your automation workflows
- 📊 **Bulk CSV Import** — Upload a spreadsheet to generate hundreds of images at once
- 🔑 **API Key Management** — Create/revoke keys with secure hashing (shown once)
- 🎯 **Playground** — Interactive template testing with live API request preview
- 📄 **Auto-generated API Docs** — Per-template documentation with copy-paste code examples
- 🪝 **Webhooks** — Get notified when renders complete or fail
- 📈 **Render Logs** — Track, retry, and delete renders
- ⚙️ **Per-project defaults** — Default format/quality/scale + configurable **render retention** with automatic cleanup
- 🔒 **Single-admin auth** — One-time setup wizard, no public sign-up
- 🔄 **Self-update checker** — One-click "check & install update" for git-based deployments
- ⚡ **Runs without Docker** — Self-contained on plain Node (in-process DB + local storage), or point it at an external **PostgreSQL**

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

Hosting on **Coolify**, **Dokploy**, or want manual Docker/VPS steps? See
**[DEPLOY.md](./DEPLOY.md)**.

### Local development

**Requirements:** Node.js **22+** (Next.js 15). No Docker needed.

```bash
git clone https://github.com/AakashKhambhaliya/canolite.git
cd canolite
npm install
npx playwright install chromium   # headless browser for rendering (~150 MB, one time)
npm run dev                        # or: PORT=3001 npm run dev
```

Open **http://localhost:3000** — on first launch you'll be guided through a
one-time **setup wizard** to create your admin account. (Image/asset URLs are
relative, so it works on any port without setting `APP_URL`.)

That's it. By default Canolite runs **fully self-contained** with no external
services:

- **Database** → in-process [PGlite](https://pglite.dev) (WASM Postgres), persisted to `./.pglite`
- **Storage** → local filesystem under `public/storage`
- **Rendering** → synchronous, in-process (headless Chromium + Sharp)

Schema migration and demo data are applied automatically on first boot.

### Run with Docker

Prefer containers? The whole app runs in one self-contained image:

```bash
docker compose up -d --build
```

Persist the two volumes (`/app/data` for the database, `/app/public/storage` for
images), set `APP_URL` to your public URL, and open the app. Full guides for
**Coolify**, **Dokploy**, and a **bare VPS** are in **[DEPLOY.md](./DEPLOY.md)**.

### Optional: external PostgreSQL

Prefer a real Postgres over the in-process PGlite? Set `DATABASE_URL` to a
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
        ├── Database: PGlite (default) or PostgreSQL
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
| Editor | Fabric.js 6 — snapping, layer reorder, Google Fonts, custom fonts |
| Rendering | Synchronous & in-process — headless Chromium (Playwright) + Sharp |
| Database | In-process PGlite by default · PostgreSQL + Drizzle ORM |
| Storage | Local filesystem (persist with a volume) |
| UI | Tailwind CSS 4 + shadcn/ui + Radix UI |
| Auth | Single-admin, session-based (bcrypt) |

---

## Deployment

Canolite runs as a **single self-contained container** (PGlite + local storage +
Chromium). Persist `/app/data` and `/app/public/storage`, set `APP_URL`, expose
port `3000`, and you're done.

See **[DEPLOY.md](./DEPLOY.md)** for step-by-step guides for **Coolify**,
**Dokploy**, and a **bare VPS** (with or without Docker).

---

## Environment Variables

All variables are optional for the default self-contained setup.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_URL` | `http://localhost:3000` | Public URL of the app. Image/asset URLs are now relative (resolve to the current origin), so this is only needed for **webhook payloads** to carry an absolute image URL. |
| `DATABASE_URL` | `pglite://.pglite` | Unset or `pglite://…` → in-process PGlite. A `postgres://…` URL uses Postgres. |
| `ADMIN_EMAIL` | — | Optional: auto-provision admin email on boot (skips the setup wizard) |
| `ADMIN_PASSWORD` | — | Optional: auto-provision admin password on boot (skips the setup wizard) |
| `MAX_UPLOAD_MB` | `10` | Max upload file size |
| `AUTH_SECRET` | — | Reserved for session signing |

---

## License

MIT
