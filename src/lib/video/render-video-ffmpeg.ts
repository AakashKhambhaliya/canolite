/**
 * Fast-path video renderer: one ffmpeg process composites everything.
 *
 * Between output frames only the video layers change — every other object is
 * static for the whole duration. So instead of piping 900 canvas snapshots
 * through Chromium (the legacy path), the static objects are painted ONCE per
 * z-segment (Chromium/Fabric, same fonts and images as always), and a single
 * ffmpeg filter graph overlays the video layers on top of them:
 *
 *   [base PNG] → overlay(video 0) → overlay(static segment) → overlay(video 1) → …
 *
 * The per-layer filter chains reuse decode.ts's fit math (scale/pad/crop) and
 * encode.ts's audio mixing, so output is equivalent to the legacy path for
 * every template the detector (simple-template.ts) lets through.
 */
import { promises as fs } from "fs";
import path from "path";
import { isImage } from "@/lib/design/predicates";
import { config } from "@/lib/config";
import { renderToBuffer, type CustomFontRef } from "@/lib/render/render-image";
import { resolveVideoSource, sanitizeLayerId } from "./decode";
import { extractPoster } from "./poster";
import { probeVideo } from "./probe";
import { runFfmpegWithProgress } from "./ffmpeg";
import { layerWantsAudio } from "./audio";
import {
  buildFastRenderArgs,
  enableWindowSec,
  type FastRenderOverlay,
  type VideoLayerGeometry,
} from "./filtergraph";
import type { PreparedVideoRender, RenderVideoResult } from "./types";
import type { VideoLayer } from "./timeline";

/** Static-patch rendering + source resolution get this slice of the bar. */
const FAST_PREP_PROGRESS_CEILING = 10;

function isVideoObject(obj: any): boolean {
  // Case-insensitive on purpose — Fabric serializes type as "Image" (see
  // timeline.ts for the history).
  return Boolean(isImage(obj) && obj.mediaType === "video" && obj.videoSrc);
}

function geometryOf(obj: any): VideoLayerGeometry {
  const opacity = Number(obj.opacity);
  return {
    left: Number(obj.left) || 0,
    top: Number(obj.top) || 0,
    originX: typeof obj.originX === "string" ? obj.originX : undefined,
    originY: typeof obj.originY === "string" ? obj.originY : undefined,
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
  };
}

/** Render one z-segment of static objects to a PNG via the normal image pipeline. */
async function renderStaticSegment(params: {
  designJson: any;
  objects: any[];
  width: number;
  height: number;
  scale: number;
  /** Request-level background override; undefined → keep the design background. */
  background: string | undefined;
  /** false for segments above a video layer: they must stay transparent. */
  keepDesignBackground: boolean;
  customFonts: CustomFontRef[];
  outPath: string;
}): Promise<void> {
  const segmentJson = { ...params.designJson, objects: params.objects };
  if (!params.keepDesignBackground) {
    // Foreground patch: neither the request background nor the design's own
    // may paint here, or it would cover the video layer below it.
    segmentJson.background = undefined;
  }
  const result = await renderToBuffer({
    designJson: segmentJson,
    width: params.width,
    height: params.height,
    format: "png",
    scale: params.scale,
    background: params.background,
    customFonts: params.customFonts,
  });
  await fs.writeFile(params.outPath, result.buffer);
}

export async function renderVideoWithFfmpeg(ctx: PreparedVideoRender): Promise<RenderVideoResult> {
  const { timeline, outputScale } = ctx;
  const rootObjects: any[] = ctx.designJson?.objects || [];

  // Split the ROOT object tree into z-ordered segments around the video
  // layers. The detector guarantees every video object is root-level (nested
  // ones force the legacy path), so a linear scan pairs video objects with
  // timeline layers in the same order collectVideoLayers() found them.
  const segments: any[][] = [[]];
  const slots: Array<{ obj: any; layer: VideoLayer }> = [];
  for (const obj of rootObjects) {
    if (isVideoObject(obj)) {
      slots.push({ obj, layer: timeline.layers[slots.length] });
      segments.push([]);
    } else {
      segments[segments.length - 1].push(obj);
    }
  }
  if (slots.length !== timeline.layers.length || slots.some((s) => !s.layer)) {
    throw new Error("Video layers could not be matched to the timeline; refusing to render with wrong geometry");
  }

  // Count the discrete preparation steps so the bar moves evenly: base
  // segment, every non-empty static segment above a video, every live video.
  let totalPrepSteps = 1; // base segment
  for (let k = 1; k < segments.length; k += 1) if (segments[k].length > 0) totalPrepSteps += 1;
  for (const slot of slots) {
    if (slot.obj.visible === false) continue;
    if (!enableWindowSec(slot.layer, timeline.durationSec)) continue;
    totalPrepSteps += 1;
  }
  totalPrepSteps = Math.max(1, totalPrepSteps);
  let prepStep = 0;
  const reportPrep = async () => {
    await ctx.onProgress?.(Math.round(2 + (prepStep / totalPrepSteps) * (FAST_PREP_PROGRESS_CEILING - 2)));
  };

  // 1. Static layers, each painted exactly once.
  const basePngPath = path.join(ctx.tmpDir, "static-base.png");
  await renderStaticSegment({
    designJson: ctx.designJson,
    objects: segments[0],
    width: ctx.width,
    height: ctx.height,
    scale: outputScale,
    // Undefined lets renderToBuffer fall back to the design's own background —
    // the same precedence the legacy canvas uses.
    background: ctx.background || undefined,
    keepDesignBackground: true,
    customFonts: ctx.customFonts,
    outPath: basePngPath,
  });
  prepStep += 1;
  await reportPrep();

  const overlays: FastRenderOverlay[] = [];
  for (let k = 1; k < segments.length; k += 1) {
    if (segments[k].length === 0) continue;
    const pngPath = path.join(ctx.tmpDir, `static-${k}.png`);
    await renderStaticSegment({
      designJson: ctx.designJson,
      objects: segments[k],
      width: ctx.width,
      height: ctx.height,
      scale: outputScale,
      background: undefined,
      keepDesignBackground: false,
      customFonts: ctx.customFonts,
      outPath: pngPath,
    });
    overlays.push({ kind: "static", pngPath });
    prepStep += 1;
    await reportPrep();
  }

  // 2. Video layers: resolve sources (SSRF-checked), confirm audio streams.
  for (const slot of slots) {
    const { obj, layer } = slot;
    // Invisible or dead layers never appear in either renderer.
    if (obj.visible === false || !enableWindowSec(layer, timeline.durationSec)) continue;

    const safeId = sanitizeLayerId(layer.layerId);
    const sourcePath = await resolveVideoSource(layer.videoSrc, ctx.tmpDir, safeId);

    let hasAudioStream = false;
    if (layerWantsAudio(layer)) {
      try {
        hasAudioStream = (await probeVideo(sourcePath)).hasAudio;
        if (!hasAudioStream) {
          ctx.warnings.push(`Layer ${layer.name}: hasAudio is set but the source has no audio stream`);
        }
      } catch (error: any) {
        ctx.warnings.push(
          `Layer ${layer.name}: could not probe audio (${error?.message || error}); rendering without audio`
        );
      }
    }

    overlays.push({ kind: "video", layer, sourcePath, geometry: geometryOf(obj), hasAudioStream });
    prepStep += 1;
    await reportPrep();
  }

  // 3. One ffmpeg pass: composite + encode.
  const outPath = path.join(ctx.tmpDir, "out.mp4");
  const { args } = buildFastRenderArgs({
    basePngPath,
    overlays,
    width: Math.max(1, Math.round(ctx.width * outputScale)),
    height: Math.max(1, Math.round(ctx.height * outputScale)),
    outputScale,
    evenWidth: ctx.evenWidth,
    evenHeight: ctx.evenHeight,
    fps: timeline.fps,
    durationSec: timeline.durationSec,
    crf: ctx.crf,
    encoder: "libx264",
    outputPath: outPath,
    progress: true,
  });

  let lastReport = 0;
  let lastReportAt = 0;
  await runFfmpegWithProgress(args, {
    totalSec: timeline.durationSec,
    timeoutMs: config.VIDEO_DECODE_TIMEOUT_MS,
    onProgress: (fraction) => {
      // Span FAST_PREP..99 like the legacy encoder loop does, but throttle:
      // ffmpeg reports several times a second and each callback is a DB write.
      const progress = Math.min(
        99,
        FAST_PREP_PROGRESS_CEILING + Math.round(fraction * (99 - FAST_PREP_PROGRESS_CEILING))
      );
      const now = Date.now();
      if (progress > lastReport && now - lastReportAt > 400) {
        lastReport = progress;
        lastReportAt = now;
        void ctx.onProgress?.(progress);
      }
    },
  });
  await ctx.onProgress?.(99);

  // 4. Poster: first frame of the finished MP4 — no browser capture needed.
  const posterPath = path.join(ctx.tmpDir, "poster.jpg");
  await extractPoster(outPath, 0, posterPath);

  const [buffer, posterBuffer] = await Promise.all([fs.readFile(outPath), fs.readFile(posterPath)]);
  return {
    buffer,
    posterBuffer,
    durationSec: timeline.durationSec,
    fps: timeline.fps,
    frameCount: timeline.frameCount,
    warnings: ctx.warnings,
  };
}
