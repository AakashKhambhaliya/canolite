# Canolite

**Self-hosted template-to-image generation platform.** Design templates in a visual editor, generate images via API. A self-hosted Bannerbear/Templated.io alternative.

![Next.js](https://img.shields.io/badge/Next.js-14.2-black) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue) ![Fabric.js](https://img.shields.io/badge/Fabric.js-5.3-orange) ![License](https://img.shields.io/badge/License-MIT-green)

---

## Features

- 🎨 **Visual Template Editor** — Fabric.js-based drag-and-drop editor with text, images, shapes, and layer management
- 🔗 **REST API** — Bannerbear-compatible API for single and batch image generation
- 📊 **Bulk CSV Import** — Upload a spreadsheet to generate hundreds of images at once
- 🔑 **API Key Management** — Create/revoke keys with secure hashing (shown once)
- 🎯 **Playground** — Interactive template testing with live API request preview
- 📄 **Auto-generated API Docs** — Per-template documentation with copy-paste code examples
- 🪝 **Webhooks** — Get notified when renders complete or fail
- 📈 **Render Logs** — Track every render with status, duration, and retry support
- 🐳 **Self-hosted** — Docker Compose with PostgreSQL, Redis, and MinIO

---

## Quick Start

### One-command install (requires Docker)

```bash
curl -sSL https://raw.githubusercontent.com/your-org/canolite/main/install.sh | bash
```

### Manual setup

```bash
# Clone
git clone https://github.com/your-org/canolite.git
cd canolite

# Start infrastructure
docker compose up -d postgres redis minio

# Install dependencies
npm install

# Set up environment
cp .env.example .env

# Run migrations
npm run db:push

# Seed demo data
npm run db:seed

# Start development server
npm run dev
```

### Default credentials
- **Email:** `demo@canolite.local`
- **Password:** `password123`

---

## Architecture

```
Browser (editor + dashboard)
        │
        ▼
Next.js App  ──┬── Dashboard pages (editor, templates, keys, playground, logs)
   (public)    └── API under /v1/* with API-key auth
        │ enqueue
        ▼
Redis + BullMQ ───────► Render Worker
        │                     │  load template → apply mods →
        │                     │  render → Sharp post-process → MinIO
        ▼                     ▼
   PostgreSQL            MinIO (S3-compatible)
```

---

## API Reference

### Authentication

```bash
Authorization: Bearer sk_live_your_api_key
```

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
  "scale": 2
}
```

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

### Check render status

```bash
GET /v1/images/:uid
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
| Framework | Next.js 14 (App Router, standalone output) |
| Language | TypeScript 5.7 |
| Editor | Fabric.js 5.3 |
| Database | PostgreSQL 16 + Drizzle ORM |
| Queue | Redis 7 + BullMQ |
| Storage | MinIO (S3-compatible) |
| UI | Tailwind CSS + shadcn/ui + Radix UI |
| Auth | Custom session-based (bcrypt + secure cookies) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `AUTH_SECRET` | — | Session signing secret |
| `APP_URL` | `http://localhost:3000` | Public URL of the app |
| `S3_ENDPOINT` | `http://localhost:9000` | MinIO/S3 endpoint |
| `S3_BUCKET` | `canolite` | S3 bucket name |
| `S3_ACCESS_KEY` | `minioadmin` | S3 access key |
| `S3_SECRET_KEY` | `minioadmin` | S3 secret key |
| `S3_FORCE_PATH_STYLE` | `true` | Force path-style URLs (MinIO) |
| `RENDER_CONCURRENCY` | `3` | Max concurrent renders |
| `MAX_UPLOAD_MB` | `10` | Max upload file size |

---

## License

MIT
