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
import { buildVideoCodecArgs, type VideoEncoder } from "./encode";

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
 *
 * Fabric positions an object by its center: originX "left" puts the center at
 * left + boxW/2, "right" at left − boxW/2, "center" at left. The overlay wants
 * the box's top-left corner, so x = (left + originOffset) × scale − boxW/2.
 */
export function overlayPixelPosition(
  geometry: VideoLayerGeometry,
  layer: VideoLayer,
  outputScale: number
): { x: number; y: number } {
  const { w, h } = layerBoxSize(layer, outputScale);
  const originX = geometry.originX || "left";
  const originY = geometry.originY || "top";
  const offsetX = originX === "center" ? 0 : originX === "right" ? -w / 2 : w / 2;
  const offsetY = originY === "center" ? 0 : originY === "bottom" ? -h / 2 : h / 2;
  const centerX = (geometry.left + offsetX) * outputScale;
  const centerY = (geometry.top + offsetY) * outputScale;
  return { x: Math.round(centerX - w / 2), y: Math.round(centerY - h / 2) };
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
  // Input -ss leaves small non-zero starting timestamps; normalize to 0 (and
  // apply playbackRate at the same time). Retime BEFORE fps: fps then
  // resamples the retimed stream at the output rate, so rate>1 skips source
  // frames and rate<1 holds them — the same sampling sourceTimeForFrame()
  // performs when the legacy renderer picks decoded frames.
  parts.push(
    layer.playbackRate === 1
      ? "setpts=PTS-STARTPTS"
      : `setpts=(PTS-STARTPTS)/${fmtNumber(layer.playbackRate)}`
  );
  parts.push(`fps=${fmtNumber(fps)}`);
  parts.push(fitFilterExpr(layer.fit, w, h));
  const opacity = geometry.opacity;
  if (opacity < 1 - 1e-6) parts.push(`format=rgba,colorchannelmixer=aa=${fmtNumber(opacity)}`);
  if (layer.loop) {
    // Cache the (box-sized, already resampled) segment and repeat it forever.
    // Memory ≈ size × w × h bytes; guarded by the budget check in
    // isSimpleVideoTemplate. Over-sizing is safe: at input EOF the filter
    // loops whatever it cached.
    const size = Math.ceil(layerSpanSec(layer) * fps) + 1;
    parts.push(`loop=loop=-1:size=${size}:start=0`);
  }
  parts.push(`setpts=PTS+${fmtNumber(window.start)}/TB`);
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

  filters.push(
    `${prevLabel}scale=${plan.evenWidth}:${plan.evenHeight}:force_original_aspect_ratio=disable[vout]`
  );

  const audio = buildAudioMixFilters(audioEntries, { padToSec: plan.durationSec });
  filters.push(...audio.filters);

  const args: string[] = ["-hide_banner", "-v", "error"];
  if (plan.progress) args.push("-progress", "pipe:1", "-nostats");
  for (const input of inputs) args.push(...input);
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (audio.filters.length > 0) args.push("-map", audio.outputLabel);
  args.push(...buildVideoCodecArgs(plan.encoder, plan.crf));
  args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
  if (audio.filters.length > 0) args.push("-c:a", "aac", "-b:a", "192k");
  // No -shortest here: every stream is already hard-bounded to durationSec
  // (looped/static inputs via -t, the mix via apad, and the output via -t).
  // `-shortest` combined with adelay→amix silently drops the whole video
  // stream in ffmpeg 7 (the mix finishes before the filter graph's first
  // video packet reaches the muxer); -t is what actually bounds the encode.
  args.push("-t", fmtNumber(plan.durationSec), "-y", plan.outputPath);

  return { args, audioInputCount: audioEntries.length };
}
