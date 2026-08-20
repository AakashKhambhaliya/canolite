import { config } from "@/lib/config";
import { runFfprobe } from "./ffmpeg";

export interface VideoProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
  codec: string | null;
  rotation: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string | undefined>;
  side_data_list?: Array<Record<string, unknown>>;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export async function probeVideo(filePath: string): Promise<VideoProbeResult> {
  const output = await runFfprobe(
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ],
    { timeoutMs: config.VIDEO_PROBE_TIMEOUT_MS }
  );

  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(output) as FfprobeJson;
  } catch (error) {
    throw new Error(`Could not parse ffprobe output: ${error instanceof Error ? error.message : String(error)}`);
  }

  const streams = parsed.streams || [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Uploaded file does not contain a video stream.");

  const rotation = normalizeRotation(readRotation(video));
  const rawWidth = Number(video.width || 0);
  const rawHeight = Number(video.height || 0);
  const rotated = Math.abs(rotation) % 180 === 90;
  const width = rotated ? rawHeight : rawWidth;
  const height = rotated ? rawWidth : rawHeight;
  const durationSec = parsePositiveNumber(video.duration) || parsePositiveNumber(parsed.format?.duration) || 0;

  return {
    durationSec,
    width,
    height,
    fps: parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    codec: video.codec_name || null,
    rotation,
  };
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === "0/0") return null;
  const [numRaw, denRaw] = value.split("/");
  const num = Number(numRaw);
  const den = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function readRotation(stream: FfprobeStream): number {
  const tagRotate = stream.tags?.rotate;
  if (tagRotate && Number.isFinite(Number(tagRotate))) return Number(tagRotate);

  for (const sideData of stream.side_data_list || []) {
    const rotation = sideData.rotation;
    if (typeof rotation === "number" && Number.isFinite(rotation)) return rotation;
    if (typeof rotation === "string" && Number.isFinite(Number(rotation))) return Number(rotation);
  }
  return 0;
}

function normalizeRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 360 ? 0 : normalized;
}
