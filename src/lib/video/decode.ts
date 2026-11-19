import { privateMedia, projectOwnsMedia } from "@/lib/security/media-access";
import { renderProject, renderSignal } from "@/lib/security/render-budget";
import { createHash } from "node:crypto";
import { promises as fs } from "fs";
import path from "path";
import { config } from "@/lib/config";
import { fetchPublic } from "@/lib/ssrf";
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
  return "layer-" + createHash("sha256").update(id).digest("hex").slice(0, 32);
}

export function storageKeyFromUrl(url: string): string | null {
  const match = url.match(/^\/storage\/(.+)$/);
  return match ? match[1] : null;
}

async function downloadRemoteVideo(url: string, outPath: string): Promise<void> {
  const res = await fetchPublic(url, {signal: renderSignal(), maxBytes: MAX_REMOTE_VIDEO_BYTES, timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "User-Agent": "CanoliteRenderer/1.0", Accept: "video/*,*/*;q=0.8" } });
  if (!res.ok) throw new Error(`Remote video returned HTTP ${res.status}`);
  await fs.writeFile(outPath, res.bytes, {signal: renderSignal()});
}

export async function resolveVideoSource(videoSrc: string, tmpDir: string, layerId: string): Promise<string> {
  const key = storageKeyFromUrl(videoSrc);
  if (key) {
    if (privateMedia() && !(await projectOwnsMedia(renderProject() || "",key))) throw new Error("Video source not available to this project");
    const file = await fs.realpath(storageFilePath(key));
    if (!file.startsWith((await fs.realpath(storageFilePath(""))) + path.sep)) throw new Error("Invalid video path");
    return file;
  }
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
