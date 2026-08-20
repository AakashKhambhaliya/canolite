export interface VideoLayer {
  layerId: string;
  name: string;
  videoSrc: string;
  trimStart: number;
  trimEnd: number;
  startAt: number;
  loop: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  hasAudio: boolean;
  boxW: number;
  boxH: number;
  fit: "cover" | "contain" | "stretch";
}

export interface Timeline {
  layers: VideoLayer[];
  fps: number;
  durationSec: number;
  frameCount: number;
}

import { config } from "@/lib/config";
import { isImage } from "@/lib/design/predicates";

const DEFAULT_FPS = config.VIDEO_DEFAULT_FPS;
const MAX_FPS = config.VIDEO_MAX_FPS;
const MAX_OUTPUT_SEC = config.VIDEO_MAX_OUTPUT_SEC;

export function collectVideoLayers(designJson: any): VideoLayer[] {
  const layers: VideoLayer[] = [];

  function walk(objects: any[], path: string) {
    for (let i = 0; i < (objects || []).length; i += 1) {
      const obj = objects[i];
      const layerPath = path ? `${path}.${i}` : `${i}`;
      // Case-insensitive on purpose (isImage lowercases). This walks the
      // SERIALIZED design, where Fabric writes type "Image" — comparing to
      // "image" directly collected zero layers, so every video render died
      // with "Template contains no video layers".
      if (isImage(obj) && obj.mediaType === "video" && obj.videoSrc) {
        const trimStart = clampNumber(obj.trimStart, 0, 0);
        const duration = clampNumber(obj.videoDuration, 0, 0);
        const rawTrimEnd = obj.trimEnd === undefined ? duration : Number(obj.trimEnd);
        const trimEnd = Math.max(trimStart, Number.isFinite(rawTrimEnd) ? rawTrimEnd : duration);
        layers.push({
          layerId: obj.id || layerPath,
          name: obj.name || obj.id || layerPath,
          videoSrc: obj.videoSrc,
          trimStart,
          trimEnd,
          startAt: clampNumber(obj.startAt, 0, 0),
          loop: obj.loop !== false,
          muted: obj.muted === true,
          volume: clampNumber(obj.volume, 1, 0),
          playbackRate: clampNumber(obj.playbackRate, 1, 0.0001),
          hasAudio: obj.hasAudio === true,
          boxW: Math.max(1, Math.round((Number(obj.width) || 1) * (Number(obj.scaleX) || 1))),
          boxH: Math.max(1, Math.round((Number(obj.height) || 1) * (Number(obj.scaleY) || 1))),
          fit: obj.fit === "contain" || obj.fit === "stretch" ? obj.fit : "cover",
        });
      }
      if (Array.isArray(obj?.objects)) walk(obj.objects, layerPath);
    }
  }

  walk(designJson?.objects || [], "");
  return layers;
}

export function buildTimeline(
  design: any,
  opts: { fps?: number; durationSec?: number } = {}
): Timeline {
  const layers = collectVideoLayers(design);
  const fps = Math.min(MAX_FPS, Math.max(1, Math.round(opts.fps || DEFAULT_FPS)));
  const autoDuration = Math.max(
    5,
    ...layers.map((layer) => {
      const sourceSpan = Math.max(0, layer.trimEnd - layer.trimStart);
      return layer.startAt + sourceSpan / layer.playbackRate;
    })
  );
  const durationSec = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : autoDuration;
  const frameCount = Math.ceil(durationSec * fps);
  const maxFrames = MAX_OUTPUT_SEC * MAX_FPS;
  if (frameCount > maxFrames) {
    throw new Error(
      `Video render too long: ${frameCount} frames exceeds the configured maximum of ${maxFrames}.`
    );
  }
  return { layers, fps, durationSec, frameCount };
}

export function sourceTimeForFrame(layer: VideoLayer, frameIdx: number, fps: number): number | null {
  const timelineTime = frameIdx / fps;
  if (timelineTime < layer.startAt) return null;

  const span = layer.trimEnd - layer.trimStart;
  if (span <= 0) return null;

  const layerTime = (timelineTime - layer.startAt) * layer.playbackRate;
  if (!layer.loop && layerTime > span) return null;

  const sourceOffset = layer.loop ? layerTime % span : Math.min(layerTime, span);
  return layer.trimStart + sourceOffset;
}

function clampNumber(value: unknown, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}
