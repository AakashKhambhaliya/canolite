import { spawnFfmpegPipe } from "./ffmpeg";
import { buildAudioMixFilters } from "./audio";
import type { DecodedLayer } from "./decode";

export interface VideoEncodeOptions {
  outPath: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  audioLayers: DecodedLayer[];
  /**
   * Pixel format of the frames piped on stdin. "jpeg" (MJPEG) is ~10× less
   * data than PNG and decodes far faster; the H.264 output is yuv420p either
   * way, so no alpha is ever needed.
   */
  frameFormat?: "png" | "jpeg";
}

/**
 * Video encoder selection. Only software libx264 is guaranteed to exist —
 * ffmpeg-static ships a CPU-only build — so hardware encoders require a
 * system ffmpeg via FFMPEG_PATH (see docs/video-rendering.md).
 */
export type VideoEncoder = "libx264";

export const DEFAULT_VIDEO_ENCODER: VideoEncoder = "libx264";

/**
 * Codec settings shared by the legacy pipe encoder and the fast-path filter
 * graph, so both paths produce equivalent H.264 output.
 */
export function buildVideoCodecArgs(encoder: VideoEncoder, crf: number): string[] {
  switch (encoder) {
    case "libx264":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf)];
  }
}

export function buildEncodeArgs(opts: VideoEncodeOptions): string[] {
  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-f",
    "image2pipe",
  ];
  if (opts.frameFormat === "jpeg") args.push("-c:v", "mjpeg");
  args.push("-framerate", String(opts.fps), "-i", "-");

  const audioEntries = [] as Parameters<typeof buildAudioMixFilters>[0];
  opts.audioLayers.forEach((decoded, idx) => {
    if (!decoded.audioPath) return;
    args.push("-i", decoded.audioPath);
    audioEntries.push({
      inputIndex: idx + 1,
      startAtSec: decoded.layer.startAt,
      volume: decoded.layer.volume,
    });
  });

  const audio = buildAudioMixFilters(audioEntries);
  if (audio.filters.length > 0) {
    args.push("-filter_complex", audio.filters.join(";"), "-map", "0:v", "-map", audio.outputLabel);
  } else {
    args.push("-map", "0:v");
  }

  args.push(
    "-vf",
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=disable`
  );
  args.push(...buildVideoCodecArgs(DEFAULT_VIDEO_ENCODER, opts.crf));
  args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
  if (audio.filters.length > 0) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  args.push("-y", opts.outPath);
  return args;
}

export function startMp4Encoder(opts: VideoEncodeOptions) {
  return spawnFfmpegPipe(buildEncodeArgs(opts));
}
