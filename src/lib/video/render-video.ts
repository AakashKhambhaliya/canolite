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
import { rasterExportIssue } from "@/lib/design/raster-budget";
import { config } from "@/lib/config";
import os from "node:os";
import path from "node:path";
import { withRenderSlot } from "@/lib/security/render-budget";
import { prepareDesignForRender } from "@/lib/render/prepare-design";
import { buildTimeline } from "./timeline";
import { qualityToCrf, type RenderVideoOptions, type RenderVideoResult, type PreparedVideoRender } from "./types";
import { resolveVideoEncoder } from "./encode";
import { chooseRenderer } from "./renderer-choice";
import { renderVideoWithChromium } from "./render-video-chromium";
import { renderVideoWithFfmpeg } from "./render-video-ffmpeg";

export function renderVideoToBuffer(opts: RenderVideoOptions): Promise<RenderVideoResult> {
  return withRenderSlot(() => renderVideoInner(opts), "video");
}

async function renderVideoInner(opts: RenderVideoOptions): Promise<RenderVideoResult> {
  const outputScale = Math.max(1, Math.min(4, opts.scale || 1));
  const timeline = buildTimeline(opts.designJson, { fps: opts.fps, durationSec: opts.durationSec });
  if (timeline.layers.length === 0) throw new Error("Template contains no video layers");

  const evenWidth = Math.ceil((opts.width * outputScale) / 2) * 2;
  const evenHeight = Math.ceil((opts.height * outputScale) / 2) * 2;
  const pixelIssue = rasterExportIssue(evenWidth,evenHeight,1);
  if (pixelIssue) throw new Error(pixelIssue);
  if (timeline.layers.length > 32 || timeline.layers.some(l => rasterExportIssue(l.boxW,l.boxH,outputScale) || l.trimEnd-l.trimStart > config.VIDEO_MAX_OUTPUT_SEC)) throw new Error("Video layer exceeds render budget");
  const warnings: string[] = [];
  if (evenWidth !== opts.width * outputScale || evenHeight !== opts.height * outputScale) {
    warnings.push(`Output dimensions rounded to even size ${evenWidth}x${evenHeight} for H.264 compatibility`);
  }

  const { designJson: renderJson, customFonts } = await prepareDesignForRender(opts.designJson, opts.projectId);

  // Decide the renderer ONCE, before any work: simple templates (axis-aligned,
  // constant-opacity video layers at root level, loop caches within budget)
  // go to the ffmpeg filter graph; everything else keeps the Chromium loop.
  const { renderer, reason } = chooseRenderer(renderJson, {
    layers: timeline.layers,
    fps: timeline.fps,
    outputScale,
    forceLegacy: process.env.VIDEO_FORCE_LEGACY_RENDERER === "1",
  });
  const useFfmpeg = renderer === "ffmpeg";
  console.log(
    `[video] ${opts.uid}: renderer=${useFfmpeg ? "ffmpeg (fast path)" : "chromium (legacy)"}` +
      `${reason ? ` (${reason})` : ""}`
  );

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canolite-video-"));
  try {

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
