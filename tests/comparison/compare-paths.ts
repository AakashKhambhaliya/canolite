/**
 * Path-equivalence comparison test.
 *
 * Renders the same demo template through BOTH video renderers — the ffmpeg
 * filter-graph fast path and the legacy Chromium loop — and asserts the
 * outputs are visually equivalent: same streams/dimensions/duration, and
 * sampled frames (plus the two poster frames) differ by less than a small
 * pixel threshold (diffed with Sharp).
 *
 * This is an integration test: it needs Chromium (Playwright), the bundled
 * ffmpeg, and port 3000 free on loopback (the legacy renderer fetches decoded
 * frames over /storage). Run: npm run test:comparison
 *
 * It stays out of `npm test` on purpose — unit tests must run anywhere.
 */
import http from "http";
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

const FFMPEG = require("ffmpeg-static") as string;
const FFPROBE = (require("ffprobe-static") as any).path as string;

// These must be set before the app modules load (config.ts / storage.ts read
// the environment at import time).
const ROOT = path.join(os.tmpdir(), `canolite-compare-${Date.now()}`);
const STORAGE_DIR = path.join(ROOT, "storage");
process.env.STORAGE_DIR = STORAGE_DIR;
process.env.VIDEO_FRAME_WORKERS = "2"; // exercise the parallel-page pool
process.env.VIDEO_FORCE_LEGACY_RENDERER = ""; // both paths are invoked directly

const PORT = 3000;
const WIDTH = 640;
const HEIGHT = 480;
const FPS = 15;

type PreparedVideoRender = import("../../src/lib/video/types").PreparedVideoRender;

let server: http.Server | null = null;
let exitCode = 0;

function fail(label: string, detail?: string): void {
  console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  exitCode = 1;
}
function ok(label: string, detail?: string): void {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Start a minimal /storage static server (what the render pages fetch from). */
function startStorageServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      if (!url.startsWith("/storage/")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const rel = decodeURIComponent(url.slice("/storage/".length));
      if (rel.includes("..")) {
        res.statusCode = 400;
        res.end();
        return;
      }
      fs.readFile(path.join(STORAGE_DIR, rel))
        .then((buf) => {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(buf);
        })
        .catch(() => {
          res.statusCode = 404;
          res.end();
        });
    });
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve());
  });
}

interface DiffStats {
  mean: number;
  pctOver30: number;
}

async function diffFrames(aPath: string, bPath: string): Promise<DiffStats> {
  const sharp = (await import("sharp")).default;
  const a = await sharp(aPath).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(bPath)
    .resize(a.info.width, a.info.height)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let over30 = 0;
  const n = a.info.width * a.info.height * 3;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    sum += d;
    if (d > 30) over30 += 1;
  }
  return { mean: sum / n, pctOver30: (over30 / n) * 100 };
}

async function extractFrame(mp4: string, atSec: number, out: string): Promise<void> {
  execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", "-y", out]);
}

function probeStreams(mp4: string): { streams: Array<{ codec_type: string; width?: number; height?: number }>; duration: number } {
  const out = execFileSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", mp4]
  ).toString();
  const parsed = JSON.parse(out);
  return {
    streams: parsed.streams || [],
    duration: Number(parsed.format?.duration || 0),
  };
}

/** The demo template: statics below and above one video layer. */
function demoDesign(): any {
  // 2x2 red poster pixel as data URI — keeps the test network-free.
  const poster =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8AAgQEDAwMTAAIuAgGGjHttpAAAAABJRU5ErkJggg==";
  return {
    version: "5.3.0",
    background: "#10233a",
    objects: [
      { type: "rect", left: 0, top: 0, width: 640, height: 96, fill: "#e0a13a", name: "header" },
      {
        type: "textbox", left: 20, top: 26, width: 600, fontSize: 36,
        fontFamily: "Arial", fontWeight: "bold", fill: "#ffffff",
        text: "Canolite path comparison", textAlign: "center", name: "title",
      },
      {
        type: "image", id: "vid1", name: "hero", mediaType: "video",
        src: poster, videoSrc: "/storage/uploads/clip.mp4",
        left: 64, top: 140, width: 640, height: 360, scaleX: 0.8, scaleY: 2 / 3,
        trimStart: 1, trimEnd: 5, startAt: 0.5, loop: false, muted: false,
        volume: 0.8, hasAudio: true, fit: "cover",
      },
      {
        type: "textbox", left: 84, top: 170, width: 300, fontSize: 30,
        fontFamily: "Arial", fill: "#ff5555", fontWeight: "bold",
        text: "FOREGROUND", name: "fg_text",
      },
      { type: "circle", left: 480, top: 330, radius: 34, fill: "#33cc88", opacity: 0.85, name: "fg_dot" },
    ],
  };
}

async function main(): Promise<void> {
  console.log("================================================================");
  console.log("  VIDEO RENDERER PATH COMPARISON (fast ffmpeg vs legacy Chromium)");
  console.log("================================================================\n");

  await fs.mkdir(path.join(STORAGE_DIR, "uploads"), { recursive: true });
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-c:a", "aac", "-b:a", "96k", "-shortest",
    "-y", path.join(STORAGE_DIR, "uploads", "clip.mp4"),
  ]);

  await startStorageServer();

  const { buildTimeline } = await import("../../src/lib/video/timeline");
  const { qualityToCrf } = await import("../../src/lib/video/types");
  const { renderVideoWithFfmpeg } = await import("../../src/lib/video/render-video-ffmpeg");
  const { renderVideoWithChromium } = await import("../../src/lib/video/render-video-chromium");
  const { auditVideoObjects, loopCacheWithinBudget } = await import("../../src/lib/video/simple-template");

  const design = demoDesign();
  const timeline = buildTimeline(design, { fps: FPS });
  const audit = auditVideoObjects(design);
  if (!audit.audit.simple || !loopCacheWithinBudget(timeline.layers, timeline.fps, 1)) {
    fail("demo template should take the fast path", audit.audit.reasons.join("; "));
    return;
  }
  ok(`timeline: ${timeline.durationSec}s @ ${timeline.fps}fps = ${timeline.frameCount} frames`);

  const makeCtx = (uid: string): PreparedVideoRender => {
    const tmpDir = path.join(STORAGE_DIR, "tmp", uid);
    return {
      uid,
      designJson: JSON.parse(JSON.stringify(design)),
      customFonts: [],
      background: null,
      width: WIDTH,
      height: HEIGHT,
      outputScale: 1,
      evenWidth: WIDTH,
      evenHeight: HEIGHT,
      timeline,
      crf: qualityToCrf("balanced"),
      encoder: "libx264",
      tmpDir,
      warnings: [],
      onProgress: () => {},
    };
  };

  const fastCtx = makeCtx("compare-fast");
  const legacyCtx = makeCtx("compare-legacy");
  await fs.mkdir(fastCtx.tmpDir, { recursive: true });
  await fs.mkdir(legacyCtx.tmpDir, { recursive: true });

  const t0 = Date.now();
  const fast = await renderVideoWithFfmpeg(fastCtx);
  const fastMs = Date.now() - t0;
  const t1 = Date.now();
  const legacy = await renderVideoWithChromium(legacyCtx);
  const legacyMs = Date.now() - t0 - fastMs;

  const fastMp4 = path.join(fastCtx.tmpDir, "out.mp4");
  const legacyMp4 = path.join(legacyCtx.tmpDir, "out.mp4");
  console.log(`\n  fast path:   ${(fast.buffer.length / 1024).toFixed(0)} KB in ${fastMs}ms`);
  console.log(`  legacy path: ${(legacy.buffer.length / 1024).toFixed(0)} KB in ${legacyMs}ms\n`);

  // --- stream/geometry equivalence -----------------------------------------
  const fastProbe = probeStreams(fastMp4);
  const legacyProbe = probeStreams(legacyMp4);
  const fastVideo = fastProbe.streams.find((s) => s.codec_type === "video");
  const legacyVideo = legacyProbe.streams.find((s) => s.codec_type === "video");
  const fastAudio = fastProbe.streams.find((s) => s.codec_type === "audio");
  const legacyAudio = legacyProbe.streams.find((s) => s.codec_type === "audio");

  if (!fastVideo) fail("fast path produced no video stream");
  else ok("fast path has a video stream");
  if (!legacyVideo) fail("legacy path produced no video stream");
  else ok("legacy path has a video stream");
  if (Boolean(fastAudio) !== Boolean(legacyAudio)) fail("audio stream presence differs between paths");
  else ok(`audio presence matches (${fastAudio ? "aac" : "none"})`);
  if (fastVideo?.width !== legacyVideo?.width || fastVideo?.height !== legacyVideo?.height) {
    fail("dimensions differ", `${fastVideo?.width}x${fastVideo?.height} vs ${legacyVideo?.width}x${legacyVideo?.height}`);
  } else {
    ok(`dimensions match (${fastVideo?.width}x${fastVideo?.height})`);
  }
  // The legacy encoder keeps `-shortest`, which ends the FILE when the audio
  // mix ends (here ~0.5s before the timeline, an artifact of the audio tail).
  // The fast path spans the full durationSec by construction (-t + padded
  // mix). Frame equivalence is therefore asserted over the span both files
  // cover, and the fast file must never be SHORTER than the legacy one.
  if (fastProbe.duration < legacyProbe.duration - 0.05) {
    fail(
      "fast path ended before the legacy path",
      `${fastProbe.duration}s vs ${legacyProbe.duration}s (legacy truncates at the audio tail via -shortest)`
    );
  } else {
    ok(
      "durations consistent",
      `fast ${fastProbe.duration}s ≥ legacy ${legacyProbe.duration}s (legacy -shortest audio-tail truncation)`
    );
  }

  // --- pixel equivalence ----------------------------------------------------
  // Two kinds of differences are expected and bounded:
  //  - statics (header, text, shapes, poster): near-identical (< ~2 mean Δ).
  //  - the video region: both paths sample the source on the output grid, but
  //    the legacy loop's 1-based frame-file mapping rounds its sampling one
  //    frame ahead of the filter graph's. The residual is a ≤1/fps temporal
  //    phase shift inside the video box plus codec noise — measured as mean
  //    Δ ≈ 5–8 on fast-moving synthetic bars (real footage is far lower),
  //    vanishing on the static-only first frame.
  const commonSpan = Math.min(fastProbe.duration, legacyProbe.duration);
  const samples = [0.05, 1.2, 2.5, 3.8, Math.max(0.1, commonSpan - 0.2)];
  const MEAN_THRESHOLD = 10; // average channel deviation per sample (0..255)
  const PCT_THRESHOLD = 8; // % of samples allowed to deviate hard
  const STATIC_MEAN_THRESHOLD = 3;
  const STATIC_PCT_THRESHOLD = 1;
  let worst = { mean: 0, pctOver30: 0, at: 0 };
  for (const at of samples) {
    const a = path.join(ROOT, `fast-${at}.png`);
    const b = path.join(ROOT, `legacy-${at}.png`);
    await extractFrame(fastMp4, at, a);
    await extractFrame(legacyMp4, at, b);
    const stats = await diffFrames(a, b);
    if (stats.mean > worst.mean) worst = { ...stats, at };
    // The first sample is before the video layer's startAt (0.5s): statics only.
    const [meanMax, pctMax] =
      at < 0.5 ? [STATIC_MEAN_THRESHOLD, STATIC_PCT_THRESHOLD] : [MEAN_THRESHOLD, PCT_THRESHOLD];
    if (stats.mean > meanMax || stats.pctOver30 > pctMax) {
      fail(
        `frame at t=${at}s differs too much`,
        `mean ${stats.mean.toFixed(2)} (max ${meanMax}), ${stats.pctOver30.toFixed(2)}% pixels >30 (max ${pctMax}%)`
      );
    } else {
      ok(`frame t=${at}s matches`, `mean Δ ${stats.mean.toFixed(2)}, ${stats.pctOver30.toFixed(3)}% pixels >30`);
    }
  }

  // The posters (fast = first encoded frame, legacy = first canvas frame).
  const posterA = path.join(ROOT, "poster-fast.jpg");
  const posterB = path.join(ROOT, "poster-legacy.jpg");
  await fs.writeFile(posterA, fast.posterBuffer);
  await fs.writeFile(posterB, legacy.posterBuffer);
  const posterStats = await diffFrames(posterA, posterB);
  if (posterStats.mean > MEAN_THRESHOLD || posterStats.pctOver30 > PCT_THRESHOLD) {
    fail("poster frames differ too much", `mean ${posterStats.mean.toFixed(2)}, ${posterStats.pctOver30.toFixed(2)}% >30`);
  } else {
    ok("poster frames match", `mean Δ ${posterStats.mean.toFixed(2)}, ${posterStats.pctOver30.toFixed(3)}% pixels >30`);
  }

  console.log(
    `\n  worst sampled frame: t=${worst.at}s (mean Δ ${worst.mean.toFixed(2)}, ${worst.pctOver30.toFixed(3)}% >30)`
  );
  console.log(`  fast path was ${(legacyMs / Math.max(1, fastMs)).toFixed(1)}× faster on this template\n`);
}

main()
  .catch((e: any) => {
    fail("harness error", e?.message || String(e));
    if (process.env.COMPARE_DEBUG) console.error(e);
  })
  .finally(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    try {
      // Close the cached Playwright browser so this process can exit.
      const { getBrowser } = await import("../../src/lib/render/render-image");
      const browser = await getBrowser();
      await browser.close();
    } catch {}
    if (!process.env.COMPARE_KEEP) {
      await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`[compare] artifacts kept in ${ROOT}`);
    }
    process.exit(exitCode);
  });
