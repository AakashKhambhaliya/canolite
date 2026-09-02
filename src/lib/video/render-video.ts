/**
 * Video render entry point.
 *
 * Picks between two renderer implementations (see docs/video-rendering.md):
 *
 *  - fast path (`render-video-ffmpeg.ts`): the static objects are composited
 *    once by Chromium and a single ffmpeg filter graph overlays the video
 *    layers — 10–50× faster on typical templates;
 *  - legacy path (`render-video-chromium.ts`): Chromium paints every output
 *    frame, so it can express anything Fabric can render.
 *
 * The choice is made per render by the "simple template" detector
 * (`simple-template.ts`); VIDEO_FORCE_LEGACY_RENDERER=1 pins the legacy path.
 * Concurrency, timeout, cleanup and the public result shape are identical no
 * matter which renderer runs.
 */
import { promises as fs } from "fs";
import { config } from "@/lib/config";
import { storageFilePath } from "@/lib/storage";
import { prepareDesignForRender } from "@/lib/render/prepare-design";
import type { CustomFontRef } from "@/lib/render/render-image";
import { buildTimeline } from "./timeline";
import { auditVideoObjects, loopCacheWithinBudget } from "./simple-template";
import { qualityToCrf, type RenderVideoOptions, type RenderVideoResult, type PreparedVideoRender } from "./types";
import { resolveVideoEncoder } from "./encode";
import { renderVideoWithChromium } from "./render-video-chromium";
import { renderVideoWithFfmpeg } from "./render-video-ffmpeg";

const VIDEO_RENDER_TIMEOUT_MS = config.VIDEO_RENDER_TIMEOUT_MS;
const VIDEO_CONCURRENCY = Math.max(1, config.VIDEO_CONCURRENCY);

let activeVideoRenders = 0;
const waiters: Array<() => void> = [];

async function acquireVideoSlot(): Promise<() => void> {
  if (activeVideoRenders < VIDEO_CONCURRENCY) {
    activeVideoRenders += 1;
    return releaseVideoSlot;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeVideoRenders += 1;
  return releaseVideoSlot;
}

function releaseVideoSlot() {
  activeVideoRenders = Math.max(0, activeVideoRenders - 1);
  const next = waiters.shift();
  if (next) next();
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function renderVideoToBuffer(opts: RenderVideoOptions): Promise<RenderVideoResult> {
  const release = await acquireVideoSlot();
  try {
    return await withTimeout(renderVideoInner(opts), VIDEO_RENDER_TIMEOUT_MS, "Video render timed out");
  } finally {
    release();
  }
}

/**
 * Test/driver entry point: run the renderer selection against an
 * already-prepared design (images inlined) without touching the asset
 * database. `renderVideoToBuffer` is the production wrapper that prepares a
 * raw design first.
 */
export async function renderVideoToBufferPrepared(
  opts: RenderVideoOptions,
  customFonts: CustomFontRef[] = []
): Promise<RenderVideoResult> {
  const release = await acquireVideoSlot();
  try {
    return await withTimeout(renderVideoInner(opts, { designJson: opts.designJson, customFonts }), VIDEO_RENDER_TIMEOUT_MS, "Video render timed out");
  } finally {
    release();
  }
}

async function renderVideoInner(
  opts: RenderVideoOptions,
  prepared?: { designJson: any; customFonts: CustomFontRef[] }
): Promise<RenderVideoResult> {
  const outputScale = Math.max(1, Math.min(4, opts.scale || 1));
  const timeline = buildTimeline(opts.designJson, { fps: opts.fps, durationSec: opts.durationSec });
  if (timeline.layers.length === 0) throw new Error("Template contains no video layers");

  const evenWidth = Math.ceil((opts.width * outputScale) / 2) * 2;
  const evenHeight = Math.ceil((opts.height * outputScale) / 2) * 2;
  const warnings: string[] = [];
  if (evenWidth !== opts.width * outputScale || evenHeight !== opts.height * outputScale) {
    warnings.push(`Output dimensions rounded to even size ${evenWidth}x${evenHeight} for H.264 compatibility`);
  }

  const { designJson: renderJson, customFonts } = prepared ?? (await prepareDesignForRender(opts.designJson, opts.projectId));

  // Decide the renderer ONCE, before any work: simple templates (axis-aligned,
  // constant-opacity video layers at root level, loop caches within budget)
  // go to the ffmpeg filter graph; everything else keeps the Chromium loop.
  const forceLegacy = process.env.VIDEO_FORCE_LEGACY_RENDERER === "1";
  const facts = auditVideoObjects(renderJson);
  const loopBudgetOk = loopCacheWithinBudget(timeline.layers, timeline.fps, outputScale);
  const useFfmpeg = !forceLegacy && facts.audit.simple && loopBudgetOk;
  const reason = !loopBudgetOk
    ? "a looping layer exceeds VIDEO_FFMPEG_LOOP_MEMORY_MB"
    : facts.audit.reasons[0];
  console.log(
    `[video] ${opts.uid}: renderer=${useFfmpeg ? "ffmpeg (fast path)" : "chromium (legacy)"}` +
      `${forceLegacy ? " (forced by VIDEO_FORCE_LEGACY_RENDERER)" : useFfmpeg ? "" : ` (legacy: ${reason})`}`
  );

  const tmpDir = storageFilePath(`tmp/${opts.uid}`);
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });

    const ctx: PreparedVideoRender = {
      uid: opts.uid,
      designJson: renderJson,
      customFonts,
      background: opts.background ?? null,
      width: opts.width,
      height: opts.height,
      outputScale,
      evenWidth,
      evenHeight,
      timeline,
      crf: qualityToCrf(opts.quality),
      encoder: resolveVideoEncoder(),
      tmpDir,
      warnings,
      onProgress: opts.onProgress,
    };

    if (useFfmpeg) {
      return await renderVideoWithFfmpeg(ctx);
    }
    return await renderVideoWithChromium(ctx);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
