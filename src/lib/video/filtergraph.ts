/**
 * Pure builder for the fast-path ffmpeg invocation.
 *
 * Given the z-ordered plan of static PNGs and video layers, produce the exact
 * argv for a single ffmpeg process that:
 *   - loops the composited static layers as the base,
 *   - opens every video source once (trimmed by -ss/-to at the demuxer),
 *   - retimes/rescales each layer (same scale/pad/crop math as decode.ts),
 *   - overlays them at their design positions inside their enable windows,
 *   - mixes layer audio (adelay/volume/amix, shared with encode.ts),
 *   - encodes H.264 with the same settings as the legacy encoder.
 *
 * No I/O happens here — everything is derivable from the plan, which is what
 * makes the generated command unit-testable.
 */
import type { VideoLayer } from "./timeline";
import { buildAudioMixFilters, layerWantsAudio, type AudioMixEntry } from "./audio";
import { buildVideoCodecArgs, isVaapiEncoder, vaapiDeviceArgs, VAAPI_UPLOAD_FILTER, type VideoEncoder } from "./encode";

export interface VideoLayerGeometry {
  left: number;
  top: number;
  originX?: string;
  originY?: string;
  /** Constant layer opacity (1 when unset). Timeline visibility uses enable. */
  opacity: number;
}

export interface FastRenderVideoOverlay {
  kind: "video";
  layer: VideoLayer;
  /** Absolute path of the video source (already SSRF-resolved/downloaded). */
  sourcePath: string;
  geometry: VideoLayerGeometry;
  /** True when ffprobe confirmed the source actually has an audio stream. */
  hasAudioStream: boolean;
}

export interface FastRenderStaticOverlay {
  kind: "static";
  /** Transparent PNG rendered once by the Chromium pipeline. */
  pngPath: string;
}

export type FastRenderOverlay = FastRenderVideoOverlay | FastRenderStaticOverlay;

export interface FastRenderPlan {
  /** PNG of everything below the first video layer, incl. the design background. */
  basePngPath: string;
  /** Remaining z-ordered segments: statics and videos interleaved. */
  overlays: FastRenderOverlay[];
  /** Design-space canvas size (design width × outputScale). */
  width: number;
  height: number;
  /** Multiplier from design units to the canvas above. */
  outputScale: number;
  /** Final H.264-compatible even dimensions. */
  evenWidth: number;
  evenHeight: number;
  fps: number;
  durationSec: number;
  crf: number;
  encoder: VideoEncoder;
  outputPath: string;
  /** Emit -progress pipe:1 (parsed by the caller for onProgress). */
  progress?: boolean;
}

/** Format a number for a filter expression without float noise. */
export function fmtNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * ffmpeg's video `loop` filter caps `size` at INT16_MAX frames (the option is
 * declared "from 0 to 32767" in libavfilter/f_loop.c). Exceeding it is not
 * clamped — the filter refuses to initialize:
 *
 *   Value 40000.000000 for parameter 'size' out of range [0 - 32767]
 *   Error applying option 'size' to filter 'loop': Result too large
 *
 * That kills the graph before a single frame is written, and the dispatcher
 * has no fallback, so the detector rejects such layers up front
 * (loopCacheWithinBudget) rather than letting the render die in ffmpeg.
 */
export const FFMPEG_LOOP_MAX_SIZE = 32767;

/**
 * Frames the `loop` filter must cache to replay one full trimmed segment.
 * Shared with the detector so the budget check and the emitted command can
 * never disagree about the size being requested.
 */
export function loopFilterSize(spanSec: number, fps: number): number {
  return Math.ceil(spanSec * fps) + 1;
}

/**
 * Output box of a video layer in the scaled design space — matches what
 * decode.ts feeds buildFrameDecodeArgs (boxW × outputScale, rounded).
 */
export function layerBoxSize(layer: VideoLayer, outputScale: number): { w: number; h: number } {
  return {
    w: Math.max(1, Math.round(layer.boxW * outputScale)),
    h: Math.max(1, Math.round(layer.boxH * outputScale)),
  };
}

/**
 * The same scale/pad/crop expression decode.ts uses per fit mode, so a layer
 * frames identically on both paths.
 */
export function fitFilterExpr(fit: VideoLayer["fit"], w: number, h: number): string {
  if (fit === "stretch") return `scale=${w}:${h}`;
  if (fit === "contain") {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
}

/**
 * Translate a Fabric object's left/top (honoring originX/originY) into the
 * top-left pixel the overlay filter needs.
 */
export function overlayPixelPosition(
  geometry: VideoLayerGeometry,
  layer: VideoLayer,
  outputScale: number
): { x: number; y: number } {
  const { w, h } = layerBoxSize(layer, outputScale);
  // All math in scaled output pixels. Fabric anchors the box per originX/
  // originY at (left, top): "left"/"top" anchor the box's top-left corner
  // (Fabric's default), "center" its center, "right"/"bottom" its far edges.
  const left = geometry.left * outputScale;
  const top = geometry.top * outputScale;
  const originX = geometry.originX || "left";
  const originY = geometry.originY || "top";
  const x = originX === "center" ? left - w / 2 : originX === "right" ? left - w : left;
  const y = originY === "center" ? top - h / 2 : originY === "bottom" ? top - h : top;
  return { x: Math.round(x), y: Math.round(y) };
}

function layerSpanSec(layer: VideoLayer): number {
  return Math.max(0, layer.trimEnd - layer.trimStart);
}

/**
 * Timeline window where a layer is visible. Looping layers stay on for the
 * whole timeline; non-looping layers end once their (rate-adjusted) source
 * span is consumed — exactly when sourceTimeForFrame() starts returning null.
 * Returns null for a dead layer that is never visible.
 */
export function enableWindowSec(
  layer: VideoLayer,
  durationSec: number
): { start: number; end: number } | null {
  const start = Math.max(0, layer.startAt);
  // A layer that starts at/after the end of the timeline is never visible;
  // treating it as dead keeps its source closed.
  if (start >= durationSec) return null;
  if (layer.loop) return { start, end: Math.max(start, durationSec) };
  const span = layerSpanSec(layer);
  if (span <= 0) return null;
  const end = start + span / Math.max(1e-6, layer.playbackRate);
  if (end <= start) return null;
  return { start, end };
}

/**
 * Input args for one video source. The trim happens at the demuxer (-ss/-to
 * input options, exactly like decode.ts). Looping is NOT done with
 * -stream_loop: input -t/-to do not re-apply per loop iteration, so loops are
 * built in the filter graph with the `loop` filter instead.
 */
export function buildVideoInputArgs(layer: VideoLayer, sourcePath: string): string[] {
  const trimStart = Math.max(0, layer.trimStart);
  const trimEnd = Math.max(trimStart, layer.trimEnd);
  return ["-ss", fmtNumber(trimStart), "-to", fmtNumber(trimEnd), "-i", sourcePath];
}

/**
 * Audio input for one layer — a second, audio-only open of the same source,
 * trimmed identically to decode.ts's audio extraction (which never loops, so
 * a looping layer's audio plays once, exactly like the legacy renderer).
 */
export function buildAudioInputArgs(layer: VideoLayer, sourcePath: string): string[] {
  return buildVideoInputArgs(layer, sourcePath);
}

/**
 * Per-layer video filter chain, up to (but excluding) the overlay. Everything
 * except the trailing setpts runs in source time; the trailing setpts drops
 * the clip onto the timeline at startAt.
 *
 * Returns null for a layer that is never visible (empty trim window or a
 * startAt at/after the end of the timeline).
 */
export function buildVideoChainFilters(params: {
  layer: VideoLayer;
  fps: number;
  outputScale: number;
  durationSec: number;
  geometry: VideoLayerGeometry;
}): string[] | null {
  const { layer, fps, outputScale, durationSec, geometry } = params;
  const window = enableWindowSec(layer, durationSec);
  if (!window || window.end <= window.start) return null;

  const { w, h } = layerBoxSize(layer, outputScale);
  const parts: string[] = [];
  // The fps filter resamples the seeked source at the output rate — the
  // same sampling decode.ts performs before numbering frame files.
  parts.push(`fps=${fmtNumber(fps)}`);
  parts.push(fitFilterExpr(layer.fit, w, h));
  const opacity = geometry.opacity;
  if (opacity < 1 - 1e-6) parts.push(`format=rgba,colorchannelmixer=aa=${fmtNumber(opacity)}`);
  if (layer.loop) {
    // Repeat the cached (box-sized) segment a FINITE number of times —
    // enough for the visible window at this playbackRate. An infinite
    // `loop` never reaches EOF and ffmpeg 7 keeps transcoding past `-t`
    // forever, hanging the render; finite repeats end the graph by
    // construction. The enable window cuts the tail (and the layer's audio
    // plays once, like the legacy loop). Memory ≈ size × w × h; guarded by
    // the budget check in loopCacheWithinBudget. Over-sizing the cache is
    // safe: at input EOF the filter loops whatever it cached.
    const size = loopFilterSize(layerSpanSec(layer), fps);
    const rate = Math.max(1e-6, layer.playbackRate);
    const repeatsNeeded = Math.max(
      0,
      Math.ceil(((window.end - window.start) * rate) / layerSpanSec(layer) - 1e-6) - 1
    );
    if (repeatsNeeded > 0) parts.push(`loop=loop=${repeatsNeeded}:size=${size}:start=0`);
  }
  // Timestamp hygiene — applied AFTER the loop filter: `loop` replays its
  // cached frames with their original pts, which RESTARTS at 0 on every
  // wrap; framesync drops non-monotonic secondary frames, so the overlay
  // would go blank after the first period. Re-indexing the j-th emitted
  // frame onto the exact j/fps grid (N counts across repeats) yields
  // strictly monotonic timestamps, and the chain's timing becomes
  // deterministic regardless of demuxer/seek behavior. The content mapping
  // becomes emitted[j] = source frame (j mod span·fps) — the legacy loop's
  // modulo.
  parts.push(`setpts=N/(${fmtNumber(fps)}*TB)`);
  // playbackRate: rescale the (now exactly gridded, monotonic) stream.
  // rate>1 skips source frames, rate<1 holds them — the same sampling
  // sourceTimeForFrame() performs when the legacy renderer picks frames.
  if (layer.playbackRate !== 1) parts.push(`setpts=PTS/${fmtNumber(layer.playbackRate)}`);
  // Shift onto the timeline. The landing point is legacy's own mapping:
  // sourceTimeForFrame() is null for t < startAt, so the first visible
  // output frame is ceil(startAt × fps) — for off-grid startAt values
  // (0.5s at 15fps = 7.5 frames) landing exactly on startAt would put every
  // frame BETWEEN grid points and make the sampled source frame ambiguous
  // (the legacy loop floors to the later grid point).
  const landStart = Math.ceil(window.start * fps - 1e-6) / fps;
  parts.push(`setpts=PTS-STARTPTS+${fmtNumber(landStart)}/TB`);
  return parts;
}

export interface FastRenderArgsResult {
  args: string[];
  /** Number of audio-only inputs opened after the video inputs. */
  audioInputCount: number;
}

/**
 * Assemble the full ffmpeg argv for the fast path. Deterministic and pure —
 * the unit tests assert on this output.
 */
export function buildFastRenderArgs(plan: FastRenderPlan): FastRenderArgsResult {
  const inputs: string[][] = [
    // Base static layer, looped for the whole output.
    ["-loop", "1", "-framerate", fmtNumber(plan.fps), "-t", fmtNumber(plan.durationSec), "-i", plan.basePngPath],
  ];

  const filters: string[] = [];
  const audioEntries: AudioMixEntry[] = [];
  let prevLabel = "[0:v]";
  let inputIndex = 1;
  let segmentIndex = 0;

  for (const overlay of plan.overlays) {
    if (overlay.kind === "static") {
      inputs.push([
        "-loop", "1", "-framerate", fmtNumber(plan.fps), "-t", fmtNumber(plan.durationSec), "-i", overlay.pngPath,
      ]);
      filters.push(`${prevLabel}[${inputIndex}:v]overlay=x=0:y=0:eof_action=pass[s${segmentIndex}]`);
      prevLabel = `[s${segmentIndex}]`;
      inputIndex += 1;
      segmentIndex += 1;
      continue;
    }

    const { layer, geometry } = overlay;
    const chainParts = buildVideoChainFilters({
      layer,
      fps: plan.fps,
      outputScale: plan.outputScale,
      durationSec: plan.durationSec,
      geometry,
    });
    if (!chainParts) continue; // never visible — no input, no overlay

    inputs.push(buildVideoInputArgs(layer, overlay.sourcePath));
    const videoIdx = inputIndex;
    inputIndex += 1;

    const label = `v${segmentIndex}`;
    filters.push(`[${videoIdx}:v]${chainParts.join(",")}[${label}]`);
    const window = enableWindowSec(layer, plan.durationSec)!;
    const { x, y } = overlayPixelPosition(geometry, layer, plan.outputScale);
    filters.push(
      `${prevLabel}[${label}]overlay=x=${x}:y=${y}:eof_action=pass:` +
        `enable='between(t,${fmtNumber(window.start)},${fmtNumber(window.end)})'[o${segmentIndex}]`
    );
    prevLabel = `[o${segmentIndex}]`;
    segmentIndex += 1;

    if (layerWantsAudio(layer) && overlay.hasAudioStream) {
      inputs.push(buildAudioInputArgs(layer, overlay.sourcePath));
      audioEntries.push({ inputIndex, startAtSec: layer.startAt, volume: layer.volume });
      inputIndex += 1;
    }
  }

  // VA-API encoders consume hardware surfaces: upload after the final scale
  // (the documented software-frames recipe; -vaapi_device is added below).
  const finalFilter = isVaapiEncoder(plan.encoder)
    ? `${prevLabel}scale=${plan.evenWidth}:${plan.evenHeight}:force_original_aspect_ratio=disable,${VAAPI_UPLOAD_FILTER}[vout]`
    : `${prevLabel}scale=${plan.evenWidth}:${plan.evenHeight}:force_original_aspect_ratio=disable[vout]`;
  filters.push(finalFilter);

  const audio = buildAudioMixFilters(audioEntries, { padToSec: plan.durationSec });
  filters.push(...audio.filters);

  const args: string[] = ["-hide_banner", "-v", "error"];
  if (isVaapiEncoder(plan.encoder)) args.push(...vaapiDeviceArgs());
  if (plan.progress) args.push("-progress", "pipe:1", "-nostats");
  for (const input of inputs) args.push(...input);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (audio.filters.length > 0) args.push("-map", audio.outputLabel);
  args.push(...buildVideoCodecArgs(plan.encoder, plan.crf));
  // yuv420p is a SOFTWARE pixel format — the VA-API encoder takes hardware
  // surfaces (nv12 via hwupload), so requesting it there breaks the encode.
  if (!isVaapiEncoder(plan.encoder)) args.push("-pix_fmt", "yuv420p");
  args.push("-movflags", "+faststart");
  if (audio.filters.length > 0) args.push("-c:a", "aac", "-b:a", "192k");
  // No -shortest here: every stream is already hard-bounded to durationSec
  // (looped/static inputs via -t, the mix via apad, and the output via -t).
  // `-shortest` combined with adelay→amix silently drops the whole video
  // stream in ffmpeg 7 (the mix finishes before the filter graph's first
  // video packet reaches the muxer); -t is what actually bounds the encode.
  args.push("-t", fmtNumber(plan.durationSec), "-y", plan.outputPath);

  return { args, audioInputCount: audioEntries.length };
}
