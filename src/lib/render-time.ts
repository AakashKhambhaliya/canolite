/**
 * Render-time statistics and estimation.
 *
 * Every finished job already records how long it took (`render_jobs.duration_ms`),
 * but nothing ever read those numbers back, so the app could never answer the
 * one question people ask before hitting Generate: "how long is this going to
 * take?". This module turns the recorded history into per-project statistics
 * and an estimate for a render that hasn't started yet.
 *
 * Estimates are scaled by output megapixels (and, for video, by frame count)
 * rather than being a flat average, so switching from 1x to 4x moves the
 * predicted time the way the real render does.
 *
 * Pure and dependency-free: the API route builds the stats, the dashboard
 * consumes them.
 */

export interface RenderTimeBucket {
  /** How many completed renders this bucket is based on. */
  samples: number;
  medianMs: number;
  p90Ms: number;
  /** Median of durationMs / output megapixels. null when unknown. */
  msPerMegapixel: number | null;
  /** Video only: median of durationMs / encoded frame. null when unknown. */
  msPerFrame: number | null;
}

export interface RenderTimeStats {
  image: RenderTimeBucket | null;
  video: RenderTimeBucket | null;
  /** Keyed by the public template id (`tmpl_…`). */
  templates: Record<
    string,
    { image: RenderTimeBucket | null; video: RenderTimeBucket | null }
  >;
  /** Renders currently queued or processing, project-wide. */
  inFlight: number;
  /** How many renders the server runs at once — batches finish that much faster. */
  concurrency: { image: number; video: number };
  updatedAt: string;
}

export interface RenderSample {
  kind: "image" | "video";
  templateId: string | null;
  durationMs: number;
  megapixels: number | null;
  frames: number | null;
}

// ---------------------------------------------------------------------------
// Building the stats
// ---------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

export function buildBucket(samples: RenderSample[]): RenderTimeBucket | null {
  if (samples.length === 0) return null;
  const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  const perMp = samples
    .filter((s) => s.megapixels && s.megapixels > 0)
    .map((s) => s.durationMs / (s.megapixels as number));
  const perFrame = samples
    .filter((s) => s.frames && s.frames > 0)
    .map((s) => s.durationMs / (s.frames as number));

  return {
    samples: samples.length,
    medianMs: Math.round(quantile(durations, 0.5)),
    p90Ms: Math.round(quantile(durations, 0.9)),
    msPerMegapixel: perMp.length ? Math.round(median(perMp) as number) : null,
    msPerFrame: perFrame.length ? Math.round(median(perFrame) as number) : null,
  };
}

export function buildRenderTimeStats(
  samples: RenderSample[],
  inFlight: number,
  concurrency: { image: number; video: number }
): RenderTimeStats {
  const byTemplate: Record<string, RenderSample[]> = {};
  for (const s of samples) {
    if (!s.templateId) continue;
    (byTemplate[s.templateId] ||= []).push(s);
  }

  const templates: RenderTimeStats["templates"] = {};
  for (const [templateId, rows] of Object.entries(byTemplate)) {
    templates[templateId] = {
      image: buildBucket(rows.filter((r) => r.kind === "image")),
      video: buildBucket(rows.filter((r) => r.kind === "video")),
    };
  }

  return {
    image: buildBucket(samples.filter((s) => s.kind === "image")),
    video: buildBucket(samples.filter((s) => s.kind === "video")),
    templates,
    inFlight,
    concurrency,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Wall-clock time for a batch of `count` identical renders.
 *
 * The queue runs `concurrency` of them at a time, so a 100-image batch is not
 * 100 x the single-render time. Rounded up to whole waves.
 */
export function estimateBatchMs(
  perRenderMs: number,
  count: number,
  concurrency: number | undefined
): number {
  const lanes = Math.max(1, concurrency || 1);
  return Math.ceil(count / lanes) * perRenderMs;
}

// ---------------------------------------------------------------------------
// Estimating an unstarted render
// ---------------------------------------------------------------------------

/**
 * Cold-start guesses, used until the project has rendered anything. Rough by
 * construction — they only have to be the right order of magnitude, and every
 * estimate says how many real samples back it.
 */
const COLD_IMAGE_BASE_MS = 700;
const COLD_IMAGE_MS_PER_MEGAPIXEL = 1100;
const COLD_VIDEO_BASE_MS = 4000;
const COLD_VIDEO_MS_PER_FRAME = 130;
/** Assumed clip length when a video template hasn't declared one. */
const ASSUMED_VIDEO_SECONDS = 5;

/** Fewer samples than this and a bucket is treated as a weak signal. */
const CONFIDENT_SAMPLES = 3;

export interface RenderTimeEstimate {
  /** Expected duration in milliseconds. */
  ms: number;
  /** Upper end of the usual range (p90), for "3–7s" style copy. */
  highMs: number;
  /** How many past renders the estimate is based on (0 = cold-start guess). */
  samples: number;
  /** Where the numbers came from, for the tooltip. */
  basis: "template" | "project" | "estimate";
}

export interface EstimateInput {
  kind: "image" | "video";
  /** Public template id, so per-template history can be preferred. */
  templateId?: string | null;
  width?: number | null;
  height?: number | null;
  scale?: number | null;
  fps?: number | null;
  durationSec?: number | null;
}

function megapixelsOf(input: EstimateInput): number | null {
  if (!input.width || !input.height) return null;
  const scale = input.scale && input.scale > 0 ? input.scale : 1;
  return (input.width * scale * input.height * scale) / 1_000_000;
}

function framesOf(input: EstimateInput): number | null {
  if (input.kind !== "video") return null;
  const fps = input.fps && input.fps > 0 ? input.fps : 30;
  const seconds =
    input.durationSec && input.durationSec > 0
      ? input.durationSec
      : ASSUMED_VIDEO_SECONDS;
  return Math.round(fps * seconds);
}

function fromBucket(
  bucket: RenderTimeBucket,
  input: EstimateInput
): { ms: number; highMs: number } {
  const frames = framesOf(input);
  if (input.kind === "video" && bucket.msPerFrame && frames) {
    const ms = bucket.msPerFrame * frames;
    return { ms, highMs: ms * (bucket.p90Ms / Math.max(bucket.medianMs, 1)) };
  }

  const mp = megapixelsOf(input);
  if (bucket.msPerMegapixel && mp) {
    const ms = bucket.msPerMegapixel * mp;
    return { ms, highMs: ms * (bucket.p90Ms / Math.max(bucket.medianMs, 1)) };
  }

  return { ms: bucket.medianMs, highMs: bucket.p90Ms };
}

function coldEstimate(input: EstimateInput): { ms: number; highMs: number } {
  if (input.kind === "video") {
    const frames = framesOf(input) ?? 150;
    const mp = megapixelsOf(input) ?? 1;
    const ms =
      COLD_VIDEO_BASE_MS + frames * COLD_VIDEO_MS_PER_FRAME * Math.max(mp, 0.5);
    return { ms, highMs: ms * 1.8 };
  }
  const mp = megapixelsOf(input) ?? 1;
  const ms = COLD_IMAGE_BASE_MS + mp * COLD_IMAGE_MS_PER_MEGAPIXEL;
  return { ms, highMs: ms * 1.8 };
}

/**
 * Predict how long a render will take, preferring the most specific history
 * available: this template's own renders, then the project's, then a
 * cold-start guess.
 */
export function estimateRenderMs(
  stats: RenderTimeStats | null | undefined,
  input: EstimateInput
): RenderTimeEstimate {
  const templateBucket = input.templateId
    ? stats?.templates?.[input.templateId]?.[input.kind]
    : null;
  if (templateBucket && templateBucket.samples >= CONFIDENT_SAMPLES) {
    const { ms, highMs } = fromBucket(templateBucket, input);
    return {
      ms: Math.round(ms),
      highMs: Math.round(highMs),
      samples: templateBucket.samples,
      basis: "template",
    };
  }

  const projectBucket = stats?.[input.kind] ?? null;
  if (projectBucket && projectBucket.samples > 0) {
    const { ms, highMs } = fromBucket(projectBucket, input);
    return {
      ms: Math.round(ms),
      highMs: Math.round(highMs),
      samples: projectBucket.samples,
      basis: "project",
    };
  }

  const { ms, highMs } = coldEstimate(input);
  return {
    ms: Math.round(ms),
    highMs: Math.round(highMs),
    samples: 0,
    basis: "estimate",
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "820ms" / "4.2s" / "2m 05s" — used for both elapsed and predicted times. */
export function formatRenderTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Coarser wording for a prediction: "~4s", "~2m". */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`;
  const minutes = ms / 60_000;
  return minutes < 10 ? `~${minutes.toFixed(1)}m` : `~${Math.round(minutes)}m`;
}

/** How an estimate is explained on hover. */
export function describeEstimate(estimate: RenderTimeEstimate): string {
  if (estimate.basis === "estimate") {
    return "No completed renders yet — this is a rough first guess. It gets accurate after a few renders.";
  }
  const scope =
    estimate.basis === "template" ? "this template" : "this project";
  return `Based on the last ${estimate.samples} completed render${
    estimate.samples === 1 ? "" : "s"
  } of ${scope}. Typically finishes within ${formatRenderTime(
    estimate.highMs
  )}.`;
}

/**
 * Remaining time for a render already in progress.
 *
 * Video jobs report real percentage progress, so once past a few percent the
 * job's own pace beats any historical average. Below that (and for images,
 * which report nothing until they finish) fall back to the estimate.
 */
export function remainingMs(params: {
  elapsedMs: number;
  progress?: number | null;
  estimateMs: number;
}): number {
  const { elapsedMs, progress, estimateMs } = params;
  if (progress && progress >= 5 && progress < 100) {
    const projectedTotal = (elapsedMs / progress) * 100;
    return Math.max(0, projectedTotal - elapsedMs);
  }
  return Math.max(0, estimateMs - elapsedMs);
}
