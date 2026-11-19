# Releasing the integrated editor

This is the regular authenticated Canolite application, not a stand-alone editor. The dashboard, navigation, sign-in and storage model are unchanged. The password-free Arena guest host is separate and is **not** included in this source tree. Do not configure a shared guest admin on a real installation.

## What changes at the persistence boundary

- Opening a template fetches a fresh working copy. Fabric prepares and checks artwork, including nested groups and background images, before replacing the live document. A failed open cannot save an incomplete design.
- Each editor save sends the document version it opened. The server compares and increments the existing `templates.version` in PostgreSQL and updates the derived API fields in the same transaction. A stale save returns **409** without changing either. **Save as copy** commits the local edits to a new template and leaves the other tab's version alone. Network errors leave the canvas dirty and retryable.
- Existing PUT clients that omit `expectedVersion` keep their original last-writer-wins behavior; such writes still advance the version. No schema migration is required. Do not mix patched and unpatched app servers behind one load balancer: old servers do not advance the counter.
- Existing designs that omit an origin keep Canolite's top-left coordinates in the editor, thumbnails, server PNGs and video renderer after the Fabric upgrade. Explicit center/right/bottom origins still take precedence. Stored media paths stay relative to the installation.
- Raster output is limited to 32 million pixels and 16,384 px per side **after scaling**. Browser zoom has a separate backing-store limit. SVG does not need a full-size raster; local storage images are embedded in the file. External images/fonts outside Canolite can still have external dependencies. Inline image imports are capped at 10 MiB. Undo keeps up to 80 entries within a character budget; large designs consequently have fewer undo steps.

## Release checks

Use Node 22+ and the checked-in lockfile. Run in a clean checkout, using a **disposable** workspace, never a customer database. The read-only CI workflow `.github/workflows/editor-quality.yml` includes the complete isolated setup.

```sh
npm ci
npx --no-install playwright install --with-deps chromium
npm audit --omit=dev
npm run typecheck && npm run lint && npm test
npm run build
```

Start the resulting application with `npm start` in that disposable environment. Set `STUDIO_TEST_URL`, `CANOLITE_TEST_EMAIL` and `CANOLITE_TEST_PASSWORD` privately, then run `npm run test:studio` and `npm run test:studio:media`. The latter needs ffmpeg and ffprobe (bundled binaries or `FFMPEG_PATH` and `FFPROBE_PATH`). It creates a small synthetic clip, uploads a font, plays and saves the clip, downloads actual output and probes the MP4. Uploaded fixtures live in the disposable storage bucket; recycle the test workspace after use.

The browser checks exercise the original dashboard, mobile controls, undo, resize, native and scaled export, two-tab conflicts, failure/retry, edits made during slow saves, recovery of missing assets and old artwork coordinates. The quality workflow does not publish or deploy anything.

## Dependency audit scope

At packaging, `npm audit --omit=dev` reported **0** on the committed production lockfile. The full audit, including the build/lint/migration toolchain, reported **20** dependency findings (11 high, 9 moderate; none critical). The remaining chains involve pattern matching/YAML in lint tooling and the esbuild development server used by migration tooling. Do not expose those tools or process untrusted projects with them. The production Docker runner installs `--omit=dev`; re-run both audits on each release. The production audit is not a penetration test or a guarantee of future results.

## Before rolling out

1. Back up **both** the database and media storage. Test restoring the pair in staging and opening/exporting a representative template. Quiesce writes during cutover if running multiple replicas.
2. Build this source (rather than pulling the upstream default image). Run the production server, not the dev server. Keep development-only linting, migration tools and dev servers off the public runtime. See the project's [deployment guide](../DEPLOY.md) for the volume layout and database options.
3. Terminate HTTPS at your domain, set `APP_URL` to that origin and configure forwarded headers correctly. Provision a unique admin account/secret. Check anonymous dashboard redirection and `/api/auth/me` = 401, then verify sign-in, edit/save/reopen, media upload and a completed render on that domain.
4. Monitor `/api/health`, failed saves/renders, memory and disk space. Choose realistic render concurrency for the host. No claim about throughput, external services, TLS or recovery on a particular production host is implied by the sandbox checks.
5. Roll back by redeploying the previous build with writes paused; this change does not drop columns or migrate storage. The previous editor does not offer the new conflict protection. Never restore old data over newer work merely to roll back code.
