/**
 * Renderer choice for a video render (pure, unit-testable).
 *
 * The ffmpeg filter graph is used only when EVERY video layer is "simple"
 * (see simple-template.ts) and every loop cache fits the memory budget;
 * everything else renders through the Chromium loop, which can express any
 * design Fabric can draw. VIDEO_FORCE_LEGACY_RENDERER=1 pins the legacy path
 * for debugging.
 */
import { auditVideoObjects, loopCacheWithinBudget } from "./simple-template";
import type { VideoLayer } from "./timeline";

export type VideoRenderer = "ffmpeg" | "chromium";

export function chooseRenderer(
  designJson: any,
  opts: { layers: VideoLayer[]; fps: number; outputScale: number; forceLegacy: boolean }
): { renderer: VideoRenderer; reason?: string } {
  if (opts.forceLegacy) return { renderer: "chromium", reason: "forced by VIDEO_FORCE_LEGACY_RENDERER" };
  const facts = auditVideoObjects(designJson);
  if (!facts.audit.simple) return { renderer: "chromium", reason: facts.audit.reasons[0] };
  if (!loopCacheWithinBudget(opts.layers, opts.fps, opts.outputScale)) {
    return { renderer: "chromium", reason: "a looping layer exceeds VIDEO_FFMPEG_LOOP_MEMORY_MB" };
  }
  return { renderer: "ffmpeg" };
}
