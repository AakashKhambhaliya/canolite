/**
 * "Simple template" detector for the video fast path.
 *
 * The ffmpeg filter-graph renderer can composite video layers that are
 * axis-aligned rectangles at a fixed z-position with constant opacity —
 * everything else (rotations, clips, skew, flips, group transforms, shadows,
 * Fabric image filters) needs per-frame canvas semantics and goes to the
 * legacy Chromium renderer. Detecting that BEFORE rendering keeps both paths
 * correct: the fast path only ever runs templates it can express exactly.
 */
import { isImage } from "@/lib/design/predicates";
import { config } from "@/lib/config";
import type { VideoLayer } from "./timeline";

export interface SimpleTemplateAudit {
  simple: boolean;
  /** Human-readable reasons the fast path was rejected (empty when simple). */
  reasons: string[];
}

export interface VideoObjectFacts {
  count: number;
  /** Root-level, visible video objects — the ones the fast path would overlay. */
  overlayCandidates: any[];
  audit: SimpleTemplateAudit;
}

const OPACITY_EPSILON = 1e-6;

function normalizeAngle(angle: unknown): number {
  const parsed = Number(angle);
  if (!Number.isFinite(parsed)) return 0;
  const normalized = ((parsed % 360) + 360) % 360;
  return normalized === 360 ? 0 : normalized;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** How a layer is named in a rejection reason. */
function labelOf(obj: any, path: string): string {
  return obj.name || obj.id || path;
}

/**
 * Structural checks that don't depend on the timeline. Nesting is rejected by
 * the caller (a video nested inside a possibly-transformed group uses
 * group-local coordinates, which the filter graph's absolute overlay
 * positions cannot express), so everything here is root-level.
 */
function auditVideoObject(obj: any, path: string, reasons: string[]): void {
  const label = labelOf(obj, path);

  const angle = normalizeAngle(obj.angle);
  if (angle !== 0) reasons.push(`${label}: angle ${angle}° is not supported by the filter graph`);

  if (obj.clipPath) reasons.push(`${label}: clipPath is not supported by the filter graph`);

  if (Math.abs(Number(obj.skewX) || 0) > OPACITY_EPSILON || Math.abs(Number(obj.skewY) || 0) > OPACITY_EPSILON) {
    reasons.push(`${label}: skew is not supported by the filter graph`);
  }

  if (obj.flipX === true || obj.flipY === true) {
    reasons.push(`${label}: flipX/flipY is not supported by the filter graph`);
  }

  // A negative scale mirrors the object — same visual as a flip.
  if ((isFiniteNumber(obj.scaleX) && obj.scaleX < 0) || (isFiniteNumber(obj.scaleY) && obj.scaleY < 0)) {
    reasons.push(`${label}: negative scale (mirror) is not supported by the filter graph`);
  }

  // Opacity must be a constant number: the timeline's visibility toggling is
  // handled with overlay's enable window, but the layer's own alpha must not
  // change over time. Anything non-numeric (e.g. an expression) → legacy.
  if (obj.opacity !== undefined && obj.opacity !== null) {
    if (!isFiniteNumber(obj.opacity)) {
      reasons.push(`${label}: opacity is not a constant number`);
    } else if (obj.opacity < 0 || obj.opacity > 1) {
      reasons.push(`${label}: opacity ${obj.opacity} is out of range`);
    }
  }

  if (obj.shadow) reasons.push(`${label}: shadow is not supported by the filter graph`);

  if (isFiniteNumber(obj.strokeWidth) && obj.strokeWidth > 0) {
    reasons.push(`${label}: stroke is not supported by the filter graph`);
  }

  if (Array.isArray(obj.filters) && obj.filters.length > 0) {
    reasons.push(`${label}: Fabric image filters are not supported by the filter graph`);
  }

  // The overlay position must be a fixed point in design space.
  if (!isFiniteNumber(obj.left) || !isFiniteNumber(obj.top)) {
    reasons.push(`${label}: video layer has no fixed left/top position`);
  }

  const originX = obj.originX === undefined ? "left" : obj.originX;
  const originY = obj.originY === undefined ? "top" : obj.originY;
  const knownOriginX = ["left", "center", "right"];
  const knownOriginY = ["top", "center", "bottom"];
  if (!knownOriginX.includes(originX) || !knownOriginY.includes(originY)) {
    reasons.push(`${label}: unsupported originX/originY (${originX}/${originY})`);
  }
}

/**
 * Walk the design in z-order and audit every video object. Returns the
 * root-level visible video objects (pairing 1:1 with timeline layers when the
 * audit is clean) plus the reasons the fast path cannot be used.
 */
export function auditVideoObjects(designJson: any): VideoObjectFacts {
  const reasons: string[] = [];
  const overlayCandidates: any[] = [];
  let count = 0;

  const walk = (objects: any[], path: string, inGroup: boolean) => {
    for (let i = 0; i < (objects || []).length; i += 1) {
      const obj = objects[i];
      const objPath = path ? `${path}.${i}` : `${i}`;
      if (isImage(obj) && obj.mediaType === "video" && obj.videoSrc) {
        count += 1;
        // Nesting disqualifies the fast path even for a hidden layer.
        // collectVideoLayers() walks into groups, so a nested video still
        // occupies a timeline slot, while the fast path pairs those slots
        // with ROOT-level objects only. Letting a hidden nested video skip
        // this check made the renderer choose the fast path and then abort
        // the whole render on the slot/layer mismatch.
        if (inGroup) {
          reasons.push(`${labelOf(obj, objPath)}: video layer is nested inside a group`);
          continue;
        }
        // visible:false never paints in either path — nothing to audit or overlay.
        if (obj.visible === false) continue;
        auditVideoObject(obj, objPath, reasons);
        overlayCandidates.push(obj);
      }
      if (Array.isArray(obj?.objects)) walk(obj.objects, objPath, true);
    }
  };
  walk(designJson?.objects || [], "", false);

  return { count, overlayCandidates, audit: { simple: reasons.length === 0, reasons } };
}

/**
 * The fast path's `loop` filter caches the trimmed segment (box-sized frames)
 * in memory. Reject templates whose loop cache would blow the configured
 * budget — those keep the legacy path, which loops by re-reading decoded
 * frames from disk instead.
 */
export function loopCacheWithinBudget(layers: VideoLayer[], fps: number, outputScale: number): boolean {
  for (const layer of layers) {
    if (!layer.loop) continue;
    const span = Math.max(0, layer.trimEnd - layer.trimStart);
    if (span <= 0) continue; // dead layer — never rendered by either path
    const frames = Math.ceil(span * fps);
    const w = Math.max(1, Math.round(layer.boxW * outputScale));
    const h = Math.max(1, Math.round(layer.boxH * outputScale));
    // The loop filter caches decoded frames in memory (RGB-ish worst case ×3).
    const bytes = frames * w * h * 3;
    if (bytes > config.VIDEO_FFMPEG_LOOP_MEMORY_MB * 1024 * 1024) {
      return false;
    }
  }
  return true;
}
