/**
 * Universal output settings.
 *
 * There used to be four independent notions of "output settings" in the app —
 * the Settings page, the editor's Output popover, the editor's Export dialog
 * and the Playground — each with its own defaults, its own option lists (scale
 * stopped at 3 in some places and 4 in others) and its own copy of the file
 * size estimator. Changing a default in Settings changed nothing anywhere else.
 *
 * This module is the single definition of what an output IS (format, quality,
 * scale, plus the MP4-only fps/duration/quality preset), what the option lists
 * are, and how the layers combine. Every surface — client and server — reads
 * from here, so there is exactly one thing to manage.
 *
 * Deliberately dependency-free (no `@/lib/config`, no db) so it can be imported
 * from client components as well as route handlers.
 */

// ---------------------------------------------------------------------------
// Option lists — the ONE place the UI takes its choices from.
// ---------------------------------------------------------------------------

export const IMAGE_FORMATS = ["png", "jpg", "webp"] as const;
export const OUTPUT_FORMATS = [...IMAGE_FORMATS, "mp4"] as const;

export type ImageFormat = (typeof IMAGE_FORMATS)[number];
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const VIDEO_QUALITY_PRESETS = ["high", "balanced", "small"] as const;
export type VideoQualityPreset = (typeof VIDEO_QUALITY_PRESETS)[number];

export const FORMAT_LABELS: Record<OutputFormat, string> = {
  png: "PNG",
  jpg: "JPG",
  webp: "WebP",
  mp4: "MP4",
};

export const VIDEO_QUALITY_LABELS: Record<VideoQualityPreset, string> = {
  high: "High quality",
  balanced: "Balanced",
  small: "Small file",
};

/** Scale multipliers offered everywhere. */
export const SCALE_OPTIONS = [1, 2, 3, 4] as const;
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;

export const MIN_QUALITY = 1;
export const MAX_QUALITY = 100;

/** UI bounds for fps. The server clamps again to its own VIDEO_MAX_FPS. */
export const MIN_FPS = 1;
export const MAX_FPS = 60;
export const FPS_PRESETS = [24, 30, 60] as const;

export const MIN_DURATION_SEC = 0.1;
export const MAX_DURATION_SEC = 120;

// ---------------------------------------------------------------------------
// The settings object
// ---------------------------------------------------------------------------

export interface OutputSettings {
  format: OutputFormat;
  /** 1-100. Image formats only; MP4 uses `videoQuality`. */
  quality: number;
  scale: number;
  fps: number;
  videoQuality: VideoQualityPreset;
  /** MP4 only. null/undefined means "as long as the timeline needs". */
  durationSec?: number | null;
}

export type PartialOutputSettings = Partial<{
  format: string | null;
  quality: number | string | null;
  scale: number | string | null;
  fps: number | string | null;
  videoQuality: string | null;
  durationSec: number | string | null;
}>;

/**
 * Last-resort values, used only when neither the project nor the template nor
 * the request says anything. Matches the historical hardcoded defaults so
 * existing installs see no behavior change.
 */
export const FALLBACK_OUTPUT_SETTINGS: OutputSettings = {
  format: "png",
  quality: 90,
  scale: 1,
  fps: 30,
  videoQuality: "balanced",
  durationSec: null,
};

// ---------------------------------------------------------------------------
// Coercion / clamping
// ---------------------------------------------------------------------------

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

/** "jpeg" is accepted everywhere as an alias of "jpg" — normalize it once. */
export function normalizeFormat(value: unknown): OutputFormat | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const v = value.toLowerCase();
  if (v === "jpeg") return "jpg";
  return (OUTPUT_FORMATS as readonly string[]).includes(v)
    ? (v as OutputFormat)
    : undefined;
}

export function normalizeVideoQuality(
  value: unknown
): VideoQualityPreset | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();
  return (VIDEO_QUALITY_PRESETS as readonly string[]).includes(v)
    ? (v as VideoQualityPreset)
    : undefined;
}

export const clampQuality = (n: number) =>
  Math.round(clamp(n, MIN_QUALITY, MAX_QUALITY));
export const clampScale = (n: number) =>
  Math.round(clamp(n, MIN_SCALE, MAX_SCALE));
export const clampFps = (n: number) => Math.round(clamp(n, MIN_FPS, MAX_FPS));
export const clampDuration = (n: number) =>
  clamp(n, MIN_DURATION_SEC, MAX_DURATION_SEC);

/**
 * Turn any loosely-typed source (a project row, a template's outputDefaults, a
 * request body, a form) into the subset of settings it actually specifies.
 * Blank strings, nulls and unparseable junk are dropped rather than coerced,
 * so an empty field means "inherit" instead of "0".
 */
export function pickOutputSettings(
  source: PartialOutputSettings | null | undefined
): Partial<OutputSettings> {
  if (!source) return {};
  const out: Partial<OutputSettings> = {};

  const format = normalizeFormat(source.format);
  if (format) out.format = format;

  const quality = num(source.quality);
  if (quality !== undefined) out.quality = clampQuality(quality);

  const scale = num(source.scale);
  if (scale !== undefined) out.scale = clampScale(scale);

  const fps = num(source.fps);
  if (fps !== undefined) out.fps = clampFps(fps);

  const videoQuality = normalizeVideoQuality(source.videoQuality);
  if (videoQuality) out.videoQuality = videoQuality;

  const durationSec = num(source.durationSec);
  if (durationSec !== undefined) out.durationSec = clampDuration(durationSec);

  return out;
}

/**
 * Combine layers of settings, lowest priority first.
 *
 * The chain is always the same, everywhere: fallback → project defaults →
 * template defaults → this request/export. A layer only overrides the keys it
 * actually specifies.
 */
export function resolveOutputSettings(
  ...layers: (PartialOutputSettings | null | undefined)[]
): OutputSettings {
  let resolved: OutputSettings = { ...FALLBACK_OUTPUT_SETTINGS };
  for (const layer of layers) {
    resolved = { ...resolved, ...pickOutputSettings(layer) };
  }
  return resolved;
}

/** Project-row shape (`projects.default*` columns) → a settings layer. */
export function projectDefaultsLayer(
  project:
    | {
        defaultFormat?: string | null;
        defaultQuality?: number | null;
        defaultScale?: number | null;
        defaultFps?: number | null;
        defaultVideoQuality?: string | null;
      }
    | null
    | undefined
): PartialOutputSettings {
  if (!project) return {};
  return {
    format: project.defaultFormat,
    quality: project.defaultQuality,
    scale: project.defaultScale,
    fps: project.defaultFps,
    videoQuality: project.defaultVideoQuality,
  };
}

// ---------------------------------------------------------------------------
// Video quality <-> CRF
// ---------------------------------------------------------------------------

export const VIDEO_QUALITY_CRF: Record<VideoQualityPreset, number> = {
  high: 18,
  balanced: 23,
  small: 28,
};

export function videoQualityToCrf(quality?: string | null): number {
  return VIDEO_QUALITY_CRF[normalizeVideoQuality(quality) ?? "balanced"];
}

export function crfToVideoQuality(crf?: number | null): VideoQualityPreset {
  if (crf === VIDEO_QUALITY_CRF.high) return "high";
  if (crf === VIDEO_QUALITY_CRF.small) return "small";
  return "balanced";
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

/**
 * How "heavy" a design is to encode. Photographic content compresses far worse
 * than flat colour and text, so the object mix moves the estimate more than the
 * pixel count does.
 */
export function designComplexity(design: any): number {
  let score = 1;
  const objects = design?.objects;
  if (Array.isArray(objects)) {
    for (const obj of objects) {
      if (obj?.type === "image") score += 1.5;
      else if (obj?.type === "i-text" || obj?.type === "textbox") score += 0.2;
      else score += 0.1;
    }
  }
  return clamp(score, 1, 6);
}

export function estimateOutputBytes(params: {
  width: number;
  height: number;
  scale: number;
  format: OutputFormat | string;
  quality: number;
  design?: any;
}): number {
  const { width, height, scale, quality } = params;
  const format = normalizeFormat(params.format) ?? "png";
  const pixels = width * scale * height * scale;
  const multiplier = designComplexity(params.design);

  const bytesPerPixel =
    format === "png"
      ? 0.05
      : format === "webp"
        ? 0.005 + (quality / 100) * 0.01
        : 0.002 + (quality / 100) * 0.015;

  return Math.round(pixels * bytesPerPixel * multiplier);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** "~1.2 MB" — the string the editor and the Playground both show. */
export function estimateOutputSizeLabel(params: {
  width: number;
  height: number;
  scale: number;
  format: OutputFormat | string;
  quality: number;
  design?: any;
}): string {
  return `~${formatBytes(estimateOutputBytes(params))}`;
}
