# Changelog

Notable changes per release. The version headings are what CI reads when it
publishes a GitHub Release, so the text under a heading becomes the release
notes for that tag.

## v1.6.6

Fixes renders failing on a fresh install with:

```
browserType.launch: Executable doesn't exist at
/root/.cache/ms-playwright/chromium_headless_shell-1223/...
```

**Root cause.** Rendering needs a Chromium whose build number matches the
installed Playwright exactly. Only the Dockerfile ever downloaded it. Every
other install path — a bare-VPS Node install, or a buildpack deploy such as
Coolify's **Railpack** (its current default *Build strategy*) or **Nixpacks** —
installed the library with no browser, started up perfectly healthy, and then
failed at the first render. The `/root/.cache`
in the path is the tell: the official image sets
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, so that path proves the Dockerfile
wasn't used.

- The browser is now downloaded by a **postinstall hook**, so it is fetched by
  the same command that installs the library and the two can't drift apart.
  This covers bare-VPS installs, buildpack deploys, and self-updates alike.
  Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to opt out (CI, build-only images).
- **Startup now says so.** If the expected browser is missing, boot logs a loud
  error naming the exact path and the command to fix it, instead of staying
  silent until someone tries to render.
- **The render error is actionable.** Playwright's stock message suggests
  `npx playwright install`, which installs whatever version npx resolves from
  the registry — not necessarily the one this app pins. The message now names
  the deterministic command.
- `DEPLOY.md` warns that Coolify's Build Pack must be `Dockerfile`, not
  Nixpacks, and how to recognise that mistake from the error path.

If you're already broken, the immediate fix is to run this in the app
directory, or switch the deployment to the Dockerfile/official image:

```
npx playwright install --with-deps chromium
```

## v1.6.5

Documentation release: adds this changelog and makes CI publish it as the
release notes, so an upgrade explains itself instead of listing raw commits.
No runtime code changes since v1.6.4.

### ⚠️ Read before upgrading from 1.5.x

**You must mount a persistent volume at `/app/data` before upgrading.**

1.5.x silently lost all state on every redeploy — the admin account, your
templates, API keys, and rendered images — because nothing was persisted
outside the container. 1.6.x fixes that, and part of the fix is that the app
now **refuses to start** when `/app/data` isn't a mounted volume, rather than
booting into a fresh empty database and looking like your work was erased.

So if you upgrade without a volume, the container will fail its health check
and your platform will roll back. That is the guard working, not a broken
release. Mount the volume first:

- **Coolify** — app → Storages → add a Volume with destination `/app/data`
- **Docker Compose** — already declared in the bundled `docker-compose.yml`
- **Bare VPS** — state lives beside the app; nothing to mount

Also check that **no `DATABASE_URL` variable exists at all** on image
deployments. Blank is worse than absent: an empty value overrides the image
default and relocates the database into the container, which is the exact trap
that caused the original data loss. The app now refuses to boot on that too.

Storage moved from `/app/public/storage` to `/app/data/storage`. Existing files
are migrated automatically on first boot, provided the old location is still
readable — if you previously mounted `/app/public/storage`, keep it mounted for
one deploy so the copy can run, then remove it.

To skip the guard on a throwaway instance, set `REQUIRE_PERSISTENT_DATA=0`.
That restores the old silent-data-loss behaviour, so treat it as a stopgap.

## v1.6.4

Publishes the GitHub Release from CI instead of by hand.

The in-app updater checks the GitHub *releases* API, and a pushed tag is
invisible to it — only a published Release makes existing installs see an
update. That step was manual and easy to miss, which is why v1.6.0 through
v1.6.3 were tagged and built but never offered to anyone.

A `release` job now runs on any `v*` tag, gated on the image push succeeding so
a release can never announce a version that isn't pullable yet.

## v1.6.3

Security and dependency updates.

- **Closed an unauthenticated SSRF.** `next/image` is never used in this app —
  every image is a plain `<img>` served from `/storage` — but the image
  optimizer was configured to allow any hostname over http and https, and
  `/_next/image` is deliberately exempt from the auth middleware. That left a
  public "fetch any URL and hand it to libvips" endpoint: it would fetch
  arbitrary hosts and ports and proxy the content back, and connection errors
  came back fast enough to use as an oracle for mapping internal networks. The
  optimizer is now disabled outright.
- **next 15.5.19 → 15.5.23.** Patch-level, clearing eight advisories including
  SSRF in rewrites via an attacker-controlled destination hostname,
  unauthenticated disclosure of internal Server Function endpoints, cache
  confusion of response bodies, and a DoS in the image optimizer.
- **sharp 0.34.5 → 0.35.3**, for the inherited libvips CVEs. This one matters
  here specifically: sharp post-processes every render, including images
  fetched from URLs a caller supplied.

`fabric` deliberately stays on 6.x. Both of its advisories are XSS via SVG
serialization, and this app never serializes SVG — it renders through
`canvas.toDataURL("png")`. The fix is a 6→7 major that would put every existing
template at risk to patch an unreachable path.

## v1.6.2

- **Pinned Playwright to exactly 1.60.0.** Each Playwright version expects one
  specific Chromium build, so a floating range meant any `npm install` could
  move the library while leaving the browser behind, breaking every render with
  `Executable doesn't exist at …/chromium_headless_shell-<build>`.
- **Renders can no longer hang forever.** The in-page work had no timeout of its
  own, so a design that never finished loading would leave the job stuck on
  "processing" and hold one of the worker's concurrency slots for the life of
  the process. A few of those and rendering stopped entirely until someone
  restarted the app. Now bounded by `RENDER_TIMEOUT_MS` (default 60s).
- **API requests no longer stall the server.** API-key verification hashed
  synchronously, blocking the event loop for ~60–100ms on every `/v1/*` call —
  time in which no other render or response could progress.

## v1.6.1

Fixes a self-update that could leave rendering broken. The updater reinstalled
dependencies when the manifest changed but never re-downloaded the browser, so
an update that bumped Playwright left every render failing until someone
connected to the server and ran the install by hand. Docker deployments were
never affected — those bake the browser into the image.

## v1.6.0

The data-persistence release. **See the upgrade notes under v1.6.5 before
installing this.**

### Data safety

- All state consolidated under a single `/app/data` mount — database, rendered
  images, uploads, and backups. Previously state was split across two mounts,
  one of which lived inside the build output directory.
- The app refuses to boot when `/app/data` isn't a mounted volume, or when a
  blank `DATABASE_URL` would relocate the database into the container. Both
  conditions used to start a fresh empty database and look like data loss.
- The demo template is no longer seeded in production. An empty dashboard is an
  unmistakable alarm; a resurrected demo template looks like the app overwrote
  your work.
- Automatic database backups before any migration runs, kept to the five most
  recent, with an `npm run db:backup` script for manual use. Backups never
  block startup.
- An instance marker detects a lost or swapped volume and warns loudly.

### Updating

- The in-app updater understands image deployments. It previously only worked
  on git checkouts, so the update button did nothing on Docker or Coolify.
- On Coolify it asks the platform to redeploy rather than trying to rebuild
  itself, and tracks progress across the container swap by watching the health
  endpoint.
- A confirmation dialog states plainly that the app will restart, that downtime
  is typically several minutes because the rebuild includes Chromium, and that
  in-flight renders will be lost.
- Update refuses to run at all when the data directory isn't persisted — a
  one-click update on unpersisted volumes is a one-click data loss.

### Fixes

- A failed `git fetch` no longer reports a phantom update available.
- Update checks no longer block the server on a synchronous network call on
  every dashboard load.
- The manual "check now" button bypasses the 12-hour cache instead of returning
  a stale "up to date".
- **Sign-in no longer succeeds and then dumps you back on the login page.** The
  session cookie was marked `Secure` based on a proxy header describing the
  proxy-to-app hop, so a proxy configured for an HTTPS domain caused the cookie
  to be discarded for visitors on plain HTTP. Login and setup now also verify
  the session actually took before navigating, and explain the cause when it
  didn't.
- `/api/health` reports the running version, commit, and build time so an
  update can be confirmed to have landed.
