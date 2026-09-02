# Video rendering: the two paths

Canolite renders templates with video layers to MP4 through one of two
renderers. Both are driven by the same entry point
(`src/lib/video/render-video.ts` → `renderVideoToBuffer`), produce the same
`RenderVideoResult`, respect the same `VIDEO_RENDER_TIMEOUT_MS` /
`VIDEO_CONCURRENCY` limits, clean their temp directories in `finally`, and
report progress to the same `onProgress` callback (DB `renderJobs.progress`).

```
                       ┌────────────────────────────┐
   design JSON ───────►│ chooseRenderer()           │
                       │ (simple-template detector) │
                       └─────────┬──────────┬───────┘
                  simple & loop  │          │ anything Fabric can draw,
                  cache fits     │          │ rotated/clipped/grouped/…
                                 ▼          ▼
                   ┌──────────────────┐  ┌────────────────────────┐
                   │ FAST: ffmpeg     │  │ LEGACY: Chromium loop  │
                   │ filter graph     │  │ (parallel pages,       │
                   │ (one process)    │  │  ordered writer)       │
                   └────────┬─────────┘  └───────────┬────────────┘
                            └──────────┬─────────────┘
                                       ▼
                          renders/<uid>.mp4 + .poster.jpg
```

## Fast path — ffmpeg filter graph (`render-video-ffmpeg.ts`)

Key observation: between output frames, only the **video layers** change.
Everything else (text, shapes, images, the background) is static for the whole
duration, and `timeline.ts` models each video layer as a fixed box that
appears at `startAt` and plays `[trimStart, trimEnd)` at `playbackRate`
(optionally looping). That is exactly what one ffmpeg filter graph can do:

1. The design's object tree is split in z-order around the video layers. Each
   run of static objects is painted **once** to a PNG by the normal Chromium
   image pipeline (`renderToBuffer`, same fonts, same Fabric), the base
   segment with the design/request background, later segments transparent.
2. A single ffmpeg process:
   - loops the base PNG (`-loop 1 -t durationSec`),
   - opens each video source once, trimmed at the demuxer (`-ss trimStart
     -to trimEnd`) — SSRF-checked by `resolveVideoSource`, same as always,
   - per layer: `fps` → `scale`/`pad`/`crop` (the **same fit math as
     `decode.ts`**) → optional `colorchannelmixer` for constant opacity →
     for looping layers a **finite** `loop` filter (infinite `loop` never
     reaches EOF and ffmpeg 7 transcodes past `-t` forever, hanging the
     render) → PTS re-indexed onto an exact `1/fps` grid — AFTER the loop,
     because `loop` replays its cache with restarting (non-monotonic)
     timestamps that framesync would drop, blanking the overlay after the
     first period → shifted onto the timeline at the layer's first visible
     frame (`ceil(startAt·fps)/fps`),
   - overlays it at the Fabric `left`/`top` position (honoring
     `originX`/`originY` and `outputScale`) inside
     `enable='between(t,startAt,end)'`, `eof_action=pass`,
   - mixes layer audio with the **same `adelay`/`volume`/`amix` filters as
     `encode.ts`** (extracted to `audio.ts`), padded to the duration with
     `apad=whole_dur` — looping layers' audio plays once, like the legacy
     path,
   - encodes `libx264 -preset veryfast -crf <quality>` `yuv420p`
     `+faststart`, bounded by `-t durationSec` (no `-shortest`; see quirk
     below), streams `-progress pipe:1` onto `onProgress`,
   - the poster is the first frame of the finished MP4 (`-frames:v 1`) —
     no browser capture.
3. Frames are never written to disk; there is no per-frame Chromium work.

### An ffmpeg 7 quirk that shaped the design

`-shortest` combined with `adelay → amix` **silently drops the entire video
stream** in ffmpeg 7: the tiny audio mix EOFs before the filter graph emits
its first video packet and the muxer stops. The fast path therefore never
passes `-shortest` — every stream is bounded to `durationSec` with `-t` plus
`apad=whole_dur`. (The legacy encoder keeps `-shortest`, so a legacy file can
end with its audio tail; the fast file always spans the timeline.)

## Legacy path — Chromium loop (`render-video-chromium.ts`)

The original pipeline, still the fallback because it can render anything
Fabric can: ffmpeg decodes each source clip to frame files on disk
(`decode.ts`), Chromium pages swap the video layers' sources frame by frame
and export the canvas, frames are piped into the encoder. Speedups (output
identical modulo JPEG quality):

- frames are exported as quality-0.95 JPEG instead of PNG (the encode target
  `yuv420p` has no alpha), and the pipe input is `-f image2pipe -c:v mjpeg`;
- `VIDEO_FRAME_WORKERS` pages (default = CPU count) render frames in
  parallel, and an `OrderedFramePipeline` feeds the encoder strictly in frame
  order with a bounded reorder buffer (back-pressure at `2 × workers`
  completed frames).

The decode-to-disk step exists **only** on this path.

## Which path runs when

`chooseRenderer()` (`renderer-choice.ts`) decides per render, and the choice
is logged, e.g. `[video] uid: renderer=ffmpeg (fast path)`.

The fast path is used when **every** video object is "simple":

- root-level (not nested in a group — group transforms change coordinates),
- `angle === 0`, no `clipPath`, no `skewX`/`skewY`, no `flipX`/`flipY`, no
  negative scale (mirror),
- constant numeric `opacity` (0–1); timeline visibility is handled with the
  `enable` window either way,
- no `shadow`, no `stroke`, no Fabric image `filters`,
- finite `left`/`top` with supported `originX` (`left|center|right`) and
  `originY` (`top|center|bottom`),
- for looping layers, the loop cache (trimmed span × fps × box pixels)
  fits `VIDEO_FFMPEG_LOOP_MEMORY_MB` (default 512 MB) — otherwise the loop
  would buffer frames in RAM and the legacy path (which loops from disk) is
  safer,
- for looping layers, the cached segment is also at most **32767 frames** —
  ffmpeg's `loop` filter hard-caps `size` there and refuses to build the
  graph above it ("Result too large"). A small box can slip under the memory
  budget while still blowing this cap, so it is checked separately.

Anything else — rotated text over video, clipped/shadowed videos, videos
inside groups, non-numeric opacity — silently uses the legacy path (the first
reason is logged). `VIDEO_FORCE_LEGACY_RENDERER=1` pins the legacy path for
debugging, regardless of the detector.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VIDEO_FORCE_LEGACY_RENDERER` | unset | `1` forces the Chromium loop for every render. |
| `VIDEO_FRAME_WORKERS` | CPU count | Parallel render pages on the legacy path. |
| `VIDEO_FFMPEG_LOOP_MEMORY_MB` | `512` | Loop-cache budget; looping layers above it go legacy. |
| `VIDEO_ENCODER` | `libx264` | `libx264`, `h264_nvenc`, `h264_vaapi`, or `h264_videotoolbox`. |

**Hardware encoders:** `ffmpeg-static` is CPU-only — libx264 works out of the
box with zero configuration. To use `h264_nvenc` / `h264_vaapi` /
`h264_videotoolbox`, install a system ffmpeg (with the relevant support) and
point `FFMPEG_PATH` at it. Only the codec flags change (`-preset veryfast
-crf N` ↔ e.g. `-preset p4 -rc vbr -cq N` for NVENC); VA-API additionally
needs a usable VAAPI device on the host. Unknown values log a warning and
fall back to libx264.

## Rough expected timings

Two-vCPU host (`VIDEO_CONCURRENCY=1`, libx264, `quality: balanced`), one
video layer with statics above and below it:

| Scenario (1080p30) | Original renderer¹ | Legacy path (JPEG + N pages) | Fast path |
|---|---|---|---|
| 8 s / 240 frames | >6 min (extrapolated) | ~3 min | **~12 s** |
| 20 s / 600 frames | >15 min (hits `VIDEO_RENDER_TIMEOUT_MS=900s`) | — | **~21 s** |
| 720p30, 20 s / 600 frames | ~24 s | ~17 s | ~13 s |

¹ Measured from the pre-change code (`f095c40`) in the same sandbox: the
per-frame Chromium round-trip (canvas render → PNG/JPEG encode → base64 over
CDP → decode in ffmpeg) dominates and scales with resolution; at 1080p the
600-frame render did not finish inside the job timeout at all.

Rules of thumb on 2 vCPU:

- Fast path cost ≈ decode of each source once + one x264 pass + a couple of
  one-time Chromium paints — essentially independent of frame count beyond
  the encode itself.
- Legacy path cost ≈ decode-to-disk + `frames / workers` browser round-trips
  + encode — the browser part is what the fast path removes.
- Long 1080p renders are where the fast path turns "minutes / times out" into
  seconds. Small 720p templates may see modest ratios (the fixed Chromium
  startup dominates); the legacy speedups (parallel pages + JPEG) still help
  roughly 1.5–2× there.

## Testing

- `npm test` runs the unit suites: the simple-template detector, the pure
  filter-graph argv builder (fit modes, startAt offsets, multi-layer z-order,
  audio, dead-layer elision, encoder args), the ordered-frame pipeline, and
  all pre-existing tests.
- `npm run test:comparison` renders one demo template through **both**
  renderers and asserts (Sharp pixel diffs) that streams/dimensions/durations
  match and sampled + poster frames differ by less than a small threshold.
  The video region carries a ≤1-frame temporal sampling phase (codec noise
  dominates: mean Δ ≈ 4–7 on fast-moving synthetic bars, ≈ 0 on real
  footage), so its thresholds are codec-loose — while z-order is asserted
  sharply: the opaque foreground text inside the video box is diffed only on
  the static patch's fully-opaque pixels (calibrated: text present ≈ Δ6–15,
  text accidentally covered by the video ≈ Δ110). It needs Chromium, ffmpeg
  and a free loopback port 3000, so it is not part of `npm test`.
