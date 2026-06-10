# Graph Report - .  (2026-06-10)

## Corpus Check
- 115 files · ~52,264 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 517 nodes · 1216 edges · 28 communities (23 shown, 5 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 110 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_UI Components & Dashboard Pages|UI Components & Dashboard Pages]]
- [[_COMMUNITY_API Routes, DB Schema & Render Core|API Routes, DB Schema & Render Core]]
- [[_COMMUNITY_Runtime Dependencies|Runtime Dependencies]]
- [[_COMMUNITY_Fonts & Image Rendering|Fonts & Image Rendering]]
- [[_COMMUNITY_Dev Dependencies & Build Config|Dev Dependencies & Build Config]]
- [[_COMMUNITY_Storage, Uploads & Cleanup|Storage, Uploads & Cleanup]]
- [[_COMMUNITY_Self-Update System|Self-Update System]]
- [[_COMMUNITY_Validation & API Keys|Validation & API Keys]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Deployment & Docker|Deployment & Docker]]
- [[_COMMUNITY_Admin Auth & Setup|Admin Auth & Setup]]
- [[_COMMUNITY_SSRF Protection|SSRF Protection]]
- [[_COMMUNITY_Root Layout & Providers|Root Layout & Providers]]
- [[_COMMUNITY_BullMQ Render Worker|BullMQ Render Worker]]
- [[_COMMUNITY_Install Script|Install Script]]
- [[_COMMUNITY_App Icon Concepts|App Icon Concepts]]
- [[_COMMUNITY_ESLint Config|ESLint Config]]
- [[_COMMUNITY_Auth Middleware|Auth Middleware]]
- [[_COMMUNITY_Claude Launch Config|Claude Launch Config]]
- [[_COMMUNITY_Health Endpoint|Health Endpoint]]
- [[_COMMUNITY_Next.js Config|Next.js Config]]
- [[_COMMUNITY_PostCSS Config|PostCSS Config]]

## God Nodes (most connected - your core abstractions)
1. `getCurrentUser()` - 50 edges
2. `cn()` - 32 edges
3. `DB` - 28 edges
4. `compilerOptions` - 16 edges
5. `processRenderJob()` - 14 edges
6. `authenticateApiKey()` - 13 edges
7. `Button` - 12 edges
8. `renderJobs` - 12 edges
9. `withCors()` - 12 edges
10. `handleOptions()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `docker-compose.yml canolite Service (Self-Contained)` --semantically_similar_to--> `docker-compose.full.yml canolite Service (External Postgres)`  [INFERRED] [semantically similar]
  docker-compose.yml → docker-compose.full.yml
- `GET()` --calls--> `getCurrentUser()`  [INFERRED]
  src/app/api/keys/route.ts → src/lib/auth.ts
- `Synchronous In-Process Render Pipeline` --rationale_for--> `Single Self-Contained Container Deployment Model`  [INFERRED]
  README.md → DEPLOY.md
- `docker-compose.yml canolite Service (Self-Contained)` --references--> `Admin Auto-Provisioning (ADMIN_EMAIL / ADMIN_PASSWORD)`  [EXTRACTED]
  docker-compose.yml → README.md
- `One-Command VPS Installer (install.sh)` --conceptually_related_to--> `Single Self-Contained Container Deployment Model`  [INFERRED]
  README.md → DEPLOY.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **GHCR Prebuilt Image Publish-and-Consume Flow** — workflows_docker_publish_build_and_push, workflows_docker_publish_ghcr_image, docker_compose_canolite_service, docker_compose_full_canolite_service, readme_one_command_install [EXTRACTED 1.00]
- **Self-Contained Single-Container Deployment Pattern** — deploy_self_contained_container, readme_pglite, readme_render_pipeline, docker_compose_canolite_service, readme_app_url [INFERRED 0.85]
- **External PostgreSQL Deployment Variant** — readme_external_postgresql, docker_compose_full_canolite_service, docker_compose_full_postgres_service [EXTRACTED 1.00]

## Communities (28 total, 5 thin omitted)

### Community 0 - "UI Components & Dashboard Pages"
Cohesion: 0.06
Nodes (65): Step, EmptyState(), EmptyStateProps, Logo(), DashboardShell(), DashboardShellProps, NAV_ITEMS, CANVAS_PRESETS (+57 more)

### Community 1 - "API Routes, DB Schema & Render Core"
Cohesion: 0.06
Nodes (72): OPTIONS(), DELETE(), POST(), DELETE(), GET(), GET(), POST(), GET() (+64 more)

### Community 2 - "Runtime Dependencies"
Cohesion: 0.05
Nodes (41): dependencies, archiver, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, bcryptjs, bullmq, class-variance-authority, clsx (+33 more)

### Community 3 - "Fonts & Image Rendering"
Cohesion: 0.08
Nodes (27): ensureFont(), familyToParam(), GOOGLE_FAMILY_SET, GOOGLE_FONTS, GOOGLE_WEIGHTS, GoogleFont, inflight, loaded (+19 more)

### Community 4 - "Dev Dependencies & Build Config"
Cohesion: 0.07
Nodes (28): devDependencies, drizzle-kit, eslint, eslint-config-next, @eslint/eslintrc, postcss, tailwindcss, @tailwindcss/postcss (+20 more)

### Community 5 - "Storage, Uploads & Cleanup"
Cohesion: 0.12
Nodes (22): DELETE(), GET(), POST(), runCleanup(), ensureDb(), GET(), appUrl(), deleteFile() (+14 more)

### Community 6 - "Self-Update System"
Cohesion: 0.14
Nodes (23): IDLE, isGitCheckout(), readStatus(), ROOT, runUpdate(), sh(), startUpdate(), STATUS_FILE (+15 more)

### Community 7 - "Validation & API Keys"
Cohesion: 0.11
Nodes (17): GET(), POST(), generateApiKey(), generateToken(), truncate(), BatchRequest, batchRequestSchema, modificationSchema (+9 more)

### Community 8 - "TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 9 - "Deployment & Docker"
Cohesion: 0.17
Nodes (20): Coolify Deployment Target, DEPLOY.md Deployment Guide, Dokploy Deployment Target, Single Self-Contained Container Deployment Model, docker-compose.yml canolite Service (Self-Contained), docker-compose.full.yml canolite Service (External Postgres), docker-compose.full.yml postgres Service, Admin Auto-Provisioning (ADMIN_EMAIL / ADMIN_PASSWORD) (+12 more)

### Community 10 - "Admin Auth & Setup"
Cohesion: 0.40
Nodes (10): POST(), users, getAdminUser(), hashPassword(), isSetupComplete(), verifyPassword(), createSession(), POST() (+2 more)

### Community 11 - "SSRF Protection"
Cohesion: 0.27
Nodes (9): inRange(), ipToLong(), isPrivateV4(), isPrivateV6(), isUrlSafe(), PRIVATE_V4, FetchedImage, fetchImage() (+1 more)

### Community 12 - "Root Layout & Providers"
Cohesion: 0.32
Nodes (4): inter, metadata, QueryProvider(), Toaster()

### Community 13 - "BullMQ Render Worker"
Cohesion: 0.29
Nodes (4): CONCURRENCY, redisOpts, renderQueue, worker

### Community 14 - "Install Script"
Cohesion: 0.60
Nodes (5): install.sh script, blue(), green(), red(), yellow()

### Community 15 - "App Icon Concepts"
Cohesion: 0.50
Nodes (5): AI Image Processing, AI Sparkle Motif, Canolite Application, Canolite App Icon, Photo Gallery Motif

### Community 16 - "ESLint Config"
Cohesion: 0.50
Nodes (3): compat, __dirname, eslintConfig

## Knowledge Gaps
- **166 isolated node(s):** `version`, `configurations`, `__dirname`, `compat`, `eslintConfig` (+161 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getCurrentUser()` connect `API Routes, DB Schema & Render Core` to `Admin Auth & Setup`, `Storage, Uploads & Cleanup`, `Self-Update System`, `Validation & API Keys`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `DB` connect `API Routes, DB Schema & Render Core` to `Admin Auth & Setup`, `Storage, Uploads & Cleanup`, `Validation & API Keys`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Runtime Dependencies` to `Dev Dependencies & Build Config`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `getCurrentUser()` (e.g. with `DELETE()` and `POST()`) actually correct?**
  _`getCurrentUser()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 8 inferred relationships involving `cn()` (e.g. with `EmptyState()` and `DashboardShell()`) actually correct?**
  _`cn()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `version`, `configurations`, `__dirname` to the rest of the system?**
  _167 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `UI Components & Dashboard Pages` be split into smaller, more focused modules?**
  _Cohesion score 0.06036662452591656 - nodes in this community are weakly interconnected._