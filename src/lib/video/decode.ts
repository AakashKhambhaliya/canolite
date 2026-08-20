import { promises as fs } from "fs";
import path from "path";
import { config } from "@/lib/config";
import { safeFetch } from "@/lib/ssrf";
import { storageFilePath } from "@/lib/storage";
import { runFfmpeg } from "./ffmpeg";
import type { VideoLayer } from "./timeline";

const MAX_REMOTE_VIDEO_BYTES = config.MAX_VIDEO_UPLOAD_MB * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface DecodedLayer {
  layer: VideoLayer;
  sourcePath: string;
  framesDir: string;
  frameExt: "jpg" | "png";
  frameCount: number;
  audioPath?: string;
}

export function sanitizeLayerId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "layer";
}

export function storageKeyFromUrl(url: string): string | null {
  const match = url.match(/^\/storage\/(.+)$/);
  return match ? match[1] : null;
}

async function downloadRemoteVideo(url: string, outPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CanoliteRenderer/1.0)",
        Accept: "video/*,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_REMOTE_VIDEO_BYTES) throw new Error("remote video is too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_REMOTE_VIDEO_BYTES) throw new Error("remote video is too large");
    await fs.writeFile(outPath, buf);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveVideoSource(videoSrc: string, tmpDir: string, layerId: string): Promise<string> {
  const key = storageKeyFromUrl(videoSrc);
  if (key) return storageFilePath(key);
  if (/^https?:\/\//i.test(videoSrc)) {
    const out = path.join(tmpDir, `${sanitizeLayerId(layerId)}-source`);
    await downloadRemoteVideo(videoSrc, out);
    return out;
  }
  throw new Error(`Unsupported video source for layer ${layerId}: only /storage and public http(s) URLs are supported`);
}

export function buildFrameDecodeArgs(params: {
  inputPath: string;
  trimStart: number;
  trimEnd: number;
  fps: number;
  boxW: number;
  boxH: number;
  fit: "cover" | "contain" | "stretch";
  framePattern: string;
}): string[] {
  const { inputPath, trimStart, trimEnd, fps, boxW, boxH, fit, framePattern } = params;
  const w = Math.max(1, Math.round(boxW));
  const h = Math.max(1, Math.round(boxH));
  let vf: string;
  if (fit === "stretch") {
    vf = `fps=${fps},scale=${w}:${h}`;
  } else if (fit === "contain") {
    vf = `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
  } else {
    vf = `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  }
  return [
    "-hide_banner",
    "-v",
    "error",
    "-ss",
    String(Math.max(0, trimStart)),
    "-to",
    String(Math.max(trimStart, trimEnd)),
    "-i",
    inputPath,
    "-vf",
    vf,
    "-q:v",
    "3",
    "-y",
    framePattern,
  ];
}

export function buildAudioExtractArgs(params: {
  inputPath: string;
  trimStart: number;
  trimEnd: number;
  outPath: string;
}): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-ss",
    String(Math.max(0, params.trimStart)),
    "-to",
    String(Math.max(params.trimStart, params.trimEnd)),
    "-i",
    params.inputPath,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-y",
    params.outPath,
  ];
}

export async function decodeLayerFrames(params: {
  layer: VideoLayer;
  fps: number;
  tmpDir: string;
  storageTmpKey: string;
  outputScale: number;
}): Promise<DecodedLayer> {
  const { layer, fps, tmpDir, storageTmpKey, outputScale } = params;
  const safeId = sanitizeLayerId(layer.layerId);
  const sourcePath = await resolveVideoSource(layer.videoSrc, tmpDir, safeId);
  const framesDir = path.join(tmpDir, safeId);
  await fs.mkdir(framesDir, { recursive: true });
  const frameExt: "jpg" | "png" = layer.fit === "contain" ? "png" : "jpg";
  const framePattern = path.join(framesDir, `%06d.${frameExt}`);

  await runFfmpeg(
    buildFrameDecodeArgs({
      inputPath: sourcePath,
      trimStart: layer.trimStart,
      trimEnd: layer.trimEnd,
      fps,
      boxW: layer.boxW * outputScale,
      boxH: layer.boxH * outputScale,
      fit: layer.fit,
      framePattern,
    }),
    { timeoutMs: config.VIDEO_DECODE_TIMEOUT_MS }
  );

  const frames = (await fs.readdir(framesDir)).filter((f) => f.endsWith(`.${frameExt}`)).sort();
  if (frames.length === 0) throw new Error(`No frames decoded for video layer ${layer.name}`);

  let audioPath: string | undefined;
  if (layer.hasAudio && !layer.muted && layer.volume > 0) {
    audioPath = path.join(framesDir, "audio.m4a");
    try {
      await runFfmpeg(buildAudioExtractArgs({ inputPath: sourcePath, trimStart: layer.trimStart, trimEnd: layer.trimEnd, outPath: audioPath }), {
        timeoutMs: config.VIDEO_DECODE_TIMEOUT_MS,
      });
    } catch {
      audioPath = undefined;
    }
  }

  return { layer, sourcePath, framesDir: `${storageTmpKey}/${safeId}`, frameExt, frameCount: frames.length, audioPath };
}
