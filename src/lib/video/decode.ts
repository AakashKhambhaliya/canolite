import { privateMedia, projectOwnsMedia } from "@/lib/security/media-access";
import { renderProject, renderSignal } from "@/lib/security/render-budget";
import { createHash } from "node:crypto";
import { promises as fs } from "fs";
import path from "path";
import { config } from "@/lib/config";
import { fetchPublic } from "@/lib/ssrf";
import { storageFilePath } from "@/lib/storage";
import { runFfmpeg } from "./ffmpeg";
import { probeVideo } from "./probe";
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

/**
 * Total remote-video bytes one render may download across ALL its layers. The
 * per-download cap alone allowed 32 layers x 100 MB in a single render.
 */
const MAX_REMOTE_VIDEO_BYTES_PER_RENDER = MAX_REMOTE_VIDEO_BYTES * 3;

/** Bytes downloaded so far, keyed by the render's lease signal (GC'd with it). */
const remoteBytesByRender = new WeakMap<AbortSignal, number>();

async function downloadRemoteVideo(url: string, outPath: string): Promise<void> {
  const signal = renderSignal();
  const used = signal ? remoteBytesByRender.get(signal) ?? 0 : 0;
  const remaining = MAX_REMOTE_VIDEO_BYTES_PER_RENDER - used;
  if (remaining <= 0) throw new Error("Remote videos in this render exceed the total download limit");
  const res = await fetchPublic(url, {signal, maxBytes: Math.min(MAX_REMOTE_VIDEO_BYTES, remaining), timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "User-Agent": "CanoliteRenderer/1.0", Accept: "video/*,*/*;q=0.8" } });
  if (signal) remoteBytesByRender.set(signal, used + res.bytes.length);
  if (!res.ok) throw new Error(`Remote video returned HTTP ${res.status}`);
  await fs.writeFile(outPath, res.bytes, {signal});
  await assertRemoteVideoAcceptable(outPath);
}

/**
 * Hold a downloaded file to the same rules an upload gets in /api/upload:
 * it must be a real video in an allowed container (ffprobe's format whitelist
 * rejects anything else) and within MAX_VIDEO_PIXELS. Without this a tiny
 * "pixel bomb" header could make the decoder allocate gigabytes before any
 * scale filter ran.
 */
async function assertRemoteVideoAcceptable(filePath: string): Promise<void> {
  let probe: Awaited<ReturnType<typeof probeVideo>>;
  try {
    probe = await probeVideo(filePath);
  } catch (error) {
    throw new Error(`Remote video could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (probe.width <= 0 || probe.height <= 0) throw new Error("Remote video metadata is invalid or incomplete");
  if (probe.width * probe.height > config.MAX_VIDEO_PIXELS) {
    throw new Error(`Remote video resolution too large. Maximum is ${config.MAX_VIDEO_PIXELS} pixels.`);
  }
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
    // format=rgba before pad: see fitFilterExpr in filtergraph.ts (odd boxes
    // on 4:2:0 input). Contain frames are written as PNG, so RGB is native.
    vf = `fps=${fps},format=rgba,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
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
  const safeId = sanitizeLayerId(layer.layerPath ?? layer.layerId);
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
