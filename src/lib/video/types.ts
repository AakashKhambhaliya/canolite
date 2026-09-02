import type { CustomFontRef } from "@/lib/render/render-image";
import type { Timeline } from "./timeline";

/** Public options for a video render — unchanged by the renderer work. */
export interface RenderVideoOptions {
  uid: string;
  designJson: any;
  projectId: string;
  width: number;
  height: number;
  fps?: number;
  durationSec?: number;
  quality?: "high" | "balanced" | "small" | number | null;
  scale?: number;
  background?: string | null;
  onProgress?: (progress: number) => Promise<void> | void;
}

/** Public result of a video render — unchanged by the renderer work. */
export interface RenderVideoResult {
  buffer: Buffer;
  posterBuffer: Buffer;
  durationSec: number;
  fps: number;
  frameCount: number;
  warnings: string[];
}

/**
 * Everything both renderer implementations need, computed once by the
 * dispatcher: the prepared design (images/fonts inlined), the timeline, and
 * the resolved output geometry. Renderer implementations only fill tmpDir.
 */
export interface PreparedVideoRender {
  uid: string;
  /** Prepared design (external images inlined as data: URLs) — what Chromium sees. */
  designJson: any;
  customFonts: CustomFontRef[];
  background: string | null;
  width: number;
  height: number;
  outputScale: number;
  evenWidth: number;
  evenHeight: number;
  timeline: Timeline;
  crf: number;
  /** Absolute path of the per-render scratch directory (already created). */
  tmpDir: string;
  /** Accumulates non-fatal notices surfaced on the render job. */
  warnings: string[];
  onProgress?: (progress: number) => Promise<void> | void;
}

export function qualityToCrf(quality?: string | number | null): number {
  if (quality === "high") return 18;
  if (quality === "small") return 28;
  if (typeof quality === "number" && Number.isFinite(quality)) return Math.min(35, Math.max(12, quality));
  return 23;
}
