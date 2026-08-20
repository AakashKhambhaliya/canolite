import { spawnFfmpegPipe } from "./ffmpeg";
import type { DecodedLayer } from "./decode";

export interface VideoEncodeOptions {
  outPath: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  audioLayers: DecodedLayer[];
}

export function buildEncodeArgs(opts: VideoEncodeOptions): string[] {
  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(opts.fps),
    "-i",
    "-",
  ];

  const audio = opts.audioLayers.filter((d) => d.audioPath);
  for (const layer of audio) args.push("-i", layer.audioPath!);

  if (audio.length > 0) {
    const filters: string[] = [];
    audio.forEach((decoded, idx) => {
      const inputIdx = idx + 1;
      const delay = Math.max(0, Math.round(decoded.layer.startAt * 1000));
      const volume = Math.max(0, decoded.layer.volume || 1);
      filters.push(`[${inputIdx}:a]adelay=${delay}|${delay},volume=${volume}[a${idx}]`);
    });
    filters.push(`${audio.map((_, idx) => `[a${idx}]`).join("")}amix=inputs=${audio.length}:dropout_transition=0[aout]`);
    args.push("-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[aout]");
  } else {
    args.push("-map", "0:v");
  }

  args.push(
    "-vf",
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=disable`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(opts.crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart"
  );
  if (audio.length > 0) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  args.push("-y", opts.outPath);
  return args;
}

export function startMp4Encoder(opts: VideoEncodeOptions) {
  return spawnFfmpegPipe(buildEncodeArgs(opts));
}
