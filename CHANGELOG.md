# Changelog

Notable changes per release. The version headings are what CI reads when it
publishes a GitHub Release, so the text under a heading becomes the release
notes for that tag.

## v1.10.0

**Video renders are 10–50× faster on typical templates.**

Between two output frames of a video render, only the video layers actually
change — the text, images and shapes around them are identical for the whole
duration. The renderer used to ignore that and repaint every frame in
Chromium, so a 30-second clip meant 900 full canvas snapshots crossing the
browser bridge.

Templates that qualify now render in a single ffmpeg pass. Chromium paints the
static objects once, and one filter graph overlays the video layers on top of
them with the same fit, trim, loop, playback-rate and audio behaviour as
before. Nothing about a template changes and no setting turns this on — it is
chosen per render.

Templates only take that path when it can reproduce the old output exactly:
video layers must be axis-aligned rectangles at the top level with constant
opacity and no rotation, clip path, skew, flip, mirror, shadow, stroke or
Fabric image filters. Anything else — rotated text over video, a clipped or
shadowed clip, a video inside a group — keeps the frame-by-frame renderer,
which can draw everything Fabric can. `VIDEO_FORCE_LEGACY_RENDERER=1` pins
every render to it, and each render logs which path it took and why.

**The frame-by-frame path got faster too.**

For templates that still need it, frames are now painted by several Chromium
pages at once (`VIDEO_FRAME_WORKERS`, default = CPU count) and handed to the
encoder strictly in order, with back-pressure bounding how many finished
frames can pile up. Frames also cross as JPEG rather than PNG — the encode
target has no alpha to preserve and the payload is roughly 10× smaller.

**Hardware video encoders.**

`VIDEO_ENCODER` selects `h264_nvenc`, `h264_vaapi` or `h264_videotoolbox`
instead of the default `libx264`, on both render paths. The bundled ffmpeg is
CPU-only, so hardware encoders need a system ffmpeg via `FFMPEG_PATH` — see
[docs/video-rendering.md](docs/video-rendering.md), which documents both paths,
the detector rules and the encoder setup.

### Fixes

- **A rendered MP4 would not play or download from its direct link.** The
  script-blocking CSP meant for uploaded SVGs was applied to every stored
  file. Navigating straight to a media file makes the browser synthesise a
  document around a `<video>`, and that CSP governs it — `default-src 'none'`
  implies `media-src 'none'`, so the player rendered black and stuck at 0:00,
  while `sandbox` without `allow-downloads` blocked saving the file. The CSP
  is now scoped to `.svg`, the only stored format that can execute anything.
- **Seeking a stored video did nothing, and large clips were slow to start.**
  The `/storage` route ignored Range requests, answering every one with the
  whole file and no `Accept-Ranges`. Ranges are now honoured (206 with
  `Content-Range`, 416 when unsatisfiable) and responses stream from disk
  instead of being read into memory in full on every request. Both faults were
  invisible in local development: they only affect installs with
  `STORAGE_DIR` set, which is every Docker deploy.
- **An interrupted render sat at "processing, 1%" forever.** Renders run
  in-process, so a restart killed the work while the job row — the only
  durable record — kept whatever progress was written when it was created.
  The retention sweep skips rows with no `completedAt`, so they never expired
  and anything polling one waited on a render that no longer existed. Such
  rows are now failed at boot with a message telling the caller to resubmit.
- **Progress was a black hole before the first encoded frame.** Nothing
  reported during image inlining, frame extraction (a five-minute timeout per
  layer) or a cold Chromium launch — minutes pinned at 1% on a slow host,
  indistinguishable from a wedged job. Decoding now reports up to 12%, loading
  the design 15%, and encoding spans 15–99%.
- **A Coolify redeploy kept running the old image.**
  `docker-compose.coolify.yml` pins the moving `latest` tag but set no pull
  policy, and Compose only pulls when the tag is absent locally. A host that
  had deployed once re-ran its cached copy forever — seen in the wild still on
  1.7.0 after 1.9.0 shipped. `pull_policy: always` re-resolves the tag on
  every deploy. Not applied to `docker-compose.yml`, which also declares
  `build: .`; combining the two makes Compose fail instead of falling back to
  a local build, so that file documents `docker compose pull` instead.

### Configuration

All optional — every one has a working default.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VIDEO_FORCE_LEGACY_RENDERER` | unset | `1` pins every render to the frame-by-frame path. |
| `VIDEO_FRAME_WORKERS` | CPU count | Parallel Chromium pages painting frames on that path. |
| `VIDEO_FFMPEG_LOOP_MEMORY_MB` | `512` | Loop-cache budget; looping layers above it use the frame-by-frame path. |
| `VIDEO_ENCODER` | `libx264` | `libx264`, `h264_nvenc`, `h264_vaapi` or `h264_videotoolbox`. |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render node used by `h264_vaapi`. |

## v1.9.0

**Video layers play in the editor.**

A video layer used to be a still poster frame on the canvas. The only way to
see what it actually did was to run a full MP4 render and watch the result.
Select a video layer and its properties panel now has a transport — play,
pause, stop, and a scrubber — that plays the real clip on the canvas.

It runs on the same timeline the renderer uses, so what you watch is what
encodes: the same trim window, `Start at` offset, loop wrap and playback rate.
Trim, fit, loop and audio settings apply *while it is playing*, so you can dial
in a trim point and see it immediately. On designs with more than one clip, a
**Preview all layers** switch plays the whole composition from zero instead of
the selected clip on its own.

Playback never touches the saved design. It draws through the layer's paint
method rather than swapping the underlying image element, so a template saved
mid-preview is byte-for-byte what it would have been at rest.

**MP4 works in the Playground.**

The Playground only ever offered PNG, JPG and WebP, so video templates could
not be exercised there at all. MP4 is now offered for templates that contain a
video layer, with frame-rate, duration and quality-preset controls, a live
progress bar while the render encodes, and a `<video>` player for the result.
The generated cURL snippet switches to `POST /v1/videos` to match — the
previous one showed `/v1/images`, which rejects `format: "mp4"` outright.

### Security

- **Uploaded SVGs were served without their protective headers on default
  installs.** The `Content-Security-Policy` and `X-Content-Type-Options` that
  defuse a script-bearing SVG were set only in the `/storage` route handler,
  but with `STORAGE_DIR` unset — the default — those files live under `public/`
  and are served by Next's static handler, which never reaches that route. Both
  headers are now declared in `next.config.mjs` so they cover every install.
- **Sign-in had no brute-force protection.** A Canolite instance has exactly one
  account, so an unthrottled login endpoint is a single-target password oracle.
  Failed attempts are now limited per client (10 per 15 minutes) with a global
  backstop against distributed attempts, checked before the password hash is
  computed. A successful sign-in clears the caller's counter.
- **Changing the password did not sign other sessions out.** Sessions are looked
  up by token alone, so every previously issued token stayed valid for its full
  30 days — the change did nothing to lock out a stolen session. All sessions
  are now dropped and the current browser is re-issued one.
- **A custom font's name could inject markup into the renderer.** The font
  family is derived from the uploaded file's name and was interpolated straight
  into a `<style>` block in the headless render page, so a name containing a
  quote or `</style>` escaped its rule. Both the family and the URL are now
  escaped, and the uploaded name is sanitized at rest.
- **`GET /api/cleanup` deleted renders.** Session cookies are `SameSite=Lax`,
  which still attaches them to top-level GET navigations, so any page that got
  an operator to follow a link could wipe their render history. `GET` now
  reports how many renders are eligible; deletion stays on `POST`.
- **Session tokens and API keys were slightly biased.** Random bytes were mapped
  onto the 62-character alphabet with `%`, over-representing eight characters by
  about 25%. Now generated with rejection sampling.
- **Template dimensions were unbounded.** A template saved with an absurd width
  or height became an out-of-memory failure in every later render of it — a
  stored denial of service. Dimensions are validated to 1–16384px.

### Fixes

- **The editor canvas was destroyed and rebuilt on every save.** The Fabric
  initialisation effect depended on the whole template query object while its
  cleanup reset the "already initialised" guard, so refreshing the cache after a
  save tore the live canvas down and recreated it — discarding the selection and
  the entire undo history. It now re-runs only when a genuinely different
  template is opened.
- **Resuming a paused video preview restarted it from the beginning**, and
  **seeking near the end broke looping** — playback rewound to the seek point,
  which is instantly past the end again, and thrashed against the last frame.
  Both came from one value serving as the clock's reference point and the start
  of the timeline at once; they are now separate.
- **Retention cleanup orphaned every video render's poster.** The sweep removed
  only `imageUrl`, leaving one JPEG per video render on disk permanently.
- **Rendered video and image jobs had no status endpoint for the dashboard.**
  `GET /api/renders/:id` now returns a single job's status and progress,
  accepting either the row id or the public `uid`.
- **Creating a template reported a generic failure.** The server's actual
  validation message is now surfaced, and the custom width/height inputs are
  clamped rather than sending a blank field as `0`.

### Dependencies

`brace-expansion` and `js-yaml` updated for published advisories, and the
lockfile regenerated — it had drifted out of sync with `package.json`, still
declaring v1.7.0 and a dependency that had been removed.

## v1.8.0

**Canolite renders video.**

Templates can now contain a video layer, and export as **MP4** alongside PNG,
JPG and WebP. Drop a video onto the canvas (MP4, WebM or MOV), trim it, set
where it starts, loop it, mute it — then export the whole design as a real
H.264 video with the rest of your layers composited on top. The same thing
works over the API: `format: "mp4"` on a template that has a video layer, plus
`/v1/videos` for creating and polling video renders.

ffmpeg and ffprobe ship with the app, so there is nothing extra to install.
Video uploads default to a 100 MB / 60 s ceiling (`MAX_VIDEO_UPLOAD_MB`,
`MAX_VIDEO_DURATION_SEC`).

**The database is now embedded PostgreSQL.**

PGlite has been replaced with a real PostgreSQL server that Canolite starts and
supervises itself. It is still zero-config — leave `DATABASE_URL` unset and the
app manages a cluster in `./data/pgdata` on its own — but it is now the same
engine you would run in production, rather than a WASM reimplementation.

An existing `.pglite` directory is migrated automatically on first boot; nothing
to do by hand. Point `DATABASE_URL` at a `postgres://` connection string to use
an external database instead. Note that `DATABASE_URL=pglite:...` is no longer
accepted and will stop the app at boot with an explanation.

**One command to run it locally.**

```bash
npm run setup
```

Installs dependencies, fetches the matching headless Chromium, and starts the
server. No `.env` required — the database, storage and asset URLs all have
working defaults.

### Fixes

- **MP4 export failed on every template that had a video layer.** Fabric
  serializes an object's type as `"Image"` while a live object reports
  `"image"`, and the video code compared against the lowercase form. Templates
  with video were recorded as having none, so MP4 was never offered as an output
  format and video renders failed with "Template contains no video layers".
- **Uploading a video larger than ~10 MB failed with "Internal server error".**
  Request bodies were being truncated at Next's default middleware limit rather
  than rejected, so multipart parsing failed on a partial payload. The limit now
  follows `MAX_VIDEO_UPLOAD_MB`, and a genuinely oversized upload gets a clear
  413 naming the limit instead of a 500.
- **Video uploads could not be inspected at all.** The bundled ffmpeg/ffprobe
  binaries resolved to a path inside the build output and failed with `ENOENT`.
- **Renders containing a stored image produced a tainted-canvas error.** Files
  under `/storage` are now served with `Access-Control-Allow-Origin` and loaded
  with CORS, so the renderer can export the canvas. This affected still images
  as well as video.
- **Template thumbnails never generated.** The guard protecting against a
  concurrent edit compared a `timestamp` column to a JavaScript `Date`, which
  cannot represent it exactly, so the update always matched zero rows — every
  card fell back to a placeholder and each boot re-rendered every template three
  times before giving up.
- The MP4 option is now available in the editor's **Output** settings, not just
  the export dialog.
- A stray database directory under `data/` is no longer picked up by `git`.

## v1.7.0

**Canolite now installs on ARM64 servers.**

The published image was `linux/amd64` only. On an ARM64 host — Oracle Ampere
(including the Always Free tier), AWS Graviton, Hetzner ARM, a Raspberry Pi —
pulling it failed outright:

```
no matching manifest for linux/arm64/v8 in the manifest list entries
```

The only way through was to build from source on the server every deploy.

`:latest` and every `v*` tag are now multi-architecture manifest lists covering
**linux/amd64 and linux/arm64**, so Docker pulls the right image automatically
and no host builds from source any more. Each architecture is built on a native
runner rather than under QEMU emulation, which keeps CI to minutes instead of
the better part of an hour.

`docker-compose.coolify.yml` drops the temporary `build:` fallback added in
v1.6.9 — with real ARM images published, every platform pulls.

Nothing to change in an existing install: pull `:latest` (or update in-app) and
you get the image matching your architecture.

No runtime code changes.

## v1.6.9

Fixes the one-click Coolify compose file on ARM64 hosts.

The published image is `linux/amd64` only, so on an ARM64 server — Oracle
Ampere, AWS Graviton, a Raspberry Pi — the deploy failed at the pull:

```
no matching manifest for linux/arm64/v8 in the manifest list entries
```

`docker-compose.coolify.yml` now carries a `build:` section, so Compose builds
from source when no prebuilt image matches the host. On x86-64 nothing changes;
on ARM64 it builds locally in a few minutes instead of failing. No
configuration change either way.

Also fixes `APP_URL`. It used Coolify's `SERVICE_FQDN_CANOLITE_3000` magic
variable, which is not populated for compose-based applications — deploys
warned `variable is not set. Defaulting to a blank string`. It now uses
`COOLIFY_FQDN`, which Coolify does inject, and still defers to an explicit
`APP_URL` set in the environment panel.

Multi-architecture images are the better long-term fix and are not done yet;
until then ARM64 hosts build from source.

No runtime changes.

## v1.6.8

One-click Coolify install. Adds `docker-compose.coolify.yml`, which declares
the persistent volume, the port and the public URL, so installing is:

1. New Resource → Application → Public Repository
2. Repository: `https://github.com/AakashKhambhaliya/canolite`
3. Build strategy: **Compose**, compose file: `docker-compose.coolify.yml`
4. Deploy

Nothing to set in the Storages tab. That tab was the whole problem: forgetting
it meant the app refused to boot — correctly, since without a real volume it
would silently lose every template, API key and render on the next redeploy —
but the failure surfaced as an unexplained "unhealthy, rolling back" deploy.
Declaring the volume in the compose file removes the chance to get it wrong.

It pulls the prebuilt image, so there is no build step and no waiting for
Chromium to download. Coolify assigns the domain and `APP_URL` follows it. The
Dockerfile strategy still works for building from source, and is documented
alongside it.

No runtime changes.

## v1.6.7

Documentation correction. No runtime changes since v1.6.6.

v1.6.6 blamed **Nixpacks** for renders failing with a browser path under
`/root/.cache`. Confirmed on a real instance since: Coolify's *Build strategy*
dropdown now defaults to **Railpack**, and it fails in exactly the same way.
Neither build strategy uses the `Dockerfile` in this repo, so neither installs
headless Chromium — the app builds, boots, passes its health check and serves
the dashboard, and then every render fails.

If rendering is broken on Coolify, check **Configuration → Build strategy**
first. It must be `Dockerfile`.

**Set the `/app/data` volume before switching.** The image enables the
persistence guard, so a first Dockerfile deploy without a mounted volume will
refuse to boot and roll back — that is the guard working, not a broken build.
Switching build strategy and adding the volume are one change, not two.

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
