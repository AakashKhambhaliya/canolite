import { promises as fs } from "fs";
import path from "path";
import { once } from "events";
import sharp from "sharp";
import { config } from "@/lib/config";
import { storageFilePath } from "@/lib/storage";
import { prepareDesignForRender } from "@/lib/render/prepare-design";
import { buildFontHead, getBrowser, getFabricSource, type CustomFontRef } from "@/lib/render/render-image";
import { buildTimeline, sourceTimeForFrame, type Timeline } from "./timeline";
import { decodeLayerFrames, type DecodedLayer } from "./decode";
import { startMp4Encoder } from "./encode";

const VIDEO_RENDER_TIMEOUT_MS = config.VIDEO_RENDER_TIMEOUT_MS;
const VIDEO_CONCURRENCY = Math.max(1, config.VIDEO_CONCURRENCY);

let activeVideoRenders = 0;
const waiters: Array<() => void> = [];

async function acquireVideoSlot(): Promise<() => void> {
  if (activeVideoRenders < VIDEO_CONCURRENCY) {
    activeVideoRenders += 1;
    return releaseVideoSlot;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeVideoRenders += 1;
  return releaseVideoSlot;
}

function releaseVideoSlot() {
  activeVideoRenders = Math.max(0, activeVideoRenders - 1);
  const next = waiters.shift();
  if (next) next();
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function collectFamilies(designJson: any): string[] {
  const set = new Set<string>();
  const walk = (objs: any[]) => {
    for (const o of objs || []) {
      if (o?.fontFamily) set.add(o.fontFamily);
      if (o?.objects) walk(o.objects);
    }
  };
  walk(designJson?.objects || []);
  return Array.from(set);
}

function qualityToCrf(quality?: string | number | null): number {
  if (quality === "high") return 18;
  if (quality === "small") return 28;
  if (typeof quality === "number" && Number.isFinite(quality)) return Math.min(35, Math.max(12, quality));
  return 23;
}

async function writeWithBackpressure(stream: NodeJS.WritableStream, chunk: Buffer) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

function frameUrlForFrame(decoded: DecodedLayer, timeline: Timeline, frameIdx: number): string | null {
  const sourceTime = sourceTimeForFrame(decoded.layer, frameIdx, timeline.fps);
  if (sourceTime === null) return null;
  const rel = Math.max(0, sourceTime - decoded.layer.trimStart);
  const idx = Math.min(decoded.frameCount, Math.max(1, Math.floor(rel * timeline.fps) + 1));
  return `/storage/${decoded.framesDir}/${String(idx).padStart(6, "0")}.${decoded.frameExt}`;
}

export interface RenderVideoOptions {
  uid: string;
  designJson: any;
  projectId: string;
  width: number;
  height: number;
  fps?: number;
  durationSec?: number;
  quality?: "high" | "balanced" | "small" | number | null;
  scale?: number;
  background?: string | null;
  onProgress?: (progress: number) => Promise<void> | void;
}

export interface RenderVideoResult {
  buffer: Buffer;
  posterBuffer: Buffer;
  durationSec: number;
  fps: number;
  frameCount: number;
  warnings: string[];
}

export async function renderVideoToBuffer(opts: RenderVideoOptions): Promise<RenderVideoResult> {
  const release = await acquireVideoSlot();
  try {
    return await withTimeout(renderVideoToBufferInner(opts), VIDEO_RENDER_TIMEOUT_MS, "Video render timed out");
  } finally {
    release();
  }
}

async function renderVideoToBufferInner(opts: RenderVideoOptions): Promise<RenderVideoResult> {
  const outputScale = Math.max(1, Math.min(4, opts.scale || 1));
  const timeline = buildTimeline(opts.designJson, { fps: opts.fps, durationSec: opts.durationSec });
  if (timeline.layers.length === 0) throw new Error("Template contains no video layers");

  const evenWidth = Math.ceil((opts.width * outputScale) / 2) * 2;
  const evenHeight = Math.ceil((opts.height * outputScale) / 2) * 2;
  const warnings: string[] = [];
  if (evenWidth !== opts.width * outputScale || evenHeight !== opts.height * outputScale) {
    warnings.push(`Output dimensions rounded to even size ${evenWidth}x${evenHeight} for H.264 compatibility`);
  }

  const storageTmpKey = `tmp/${opts.uid}`;
  const tmpDir = storageFilePath(storageTmpKey);
  const outPath = path.join(tmpDir, "out.mp4");
  let page: any;
  let encoder: ReturnType<typeof startMp4Encoder> | null = null;

  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });

    const { designJson: renderJson, customFonts } = await prepareDesignForRender(opts.designJson, opts.projectId);
    const decoded: DecodedLayer[] = [];
    for (const layer of timeline.layers) {
      decoded.push(await decodeLayerFrames({ layer, fps: timeline.fps, tmpDir, storageTmpKey, outputScale }));
    }

    const families = collectFamilies(renderJson);
    const fontHead = buildFontHead(families, customFonts as CustomFontRef[]);
    const fabric = await getFabricSource();
    const browser = await getBrowser();
    page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(VIDEO_RENDER_TIMEOUT_MS);
    const base = `http://127.0.0.1:${process.env.PORT || "3000"}`;
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><base href="${base}/">
       <style>html,body{margin:0;padding:0;background:#fff}</style>${fontHead}<script>${fabric}</script></head>
       <body><canvas id="c"></canvas></body></html>`,
      { waitUntil: "load" }
    );

    await page.evaluate(
      async ({ designJson, width, height, background, families }: any) => {
        const f = (window as any).fabric;
        const el = document.getElementById("c") as HTMLCanvasElement;
        const canvas = new f.StaticCanvas(el, { width, height, enableRetinaScaling: false });
        (window as any).__canoliteCanvas = canvas;
        if (background) canvas.backgroundColor = background;
        try {
          const fonts: any = (document as any).fonts;
          if (fonts) {
            await Promise.all((families as string[]).map((fam) => fonts.load(`16px "${fam}"`).catch(() => {})));
            await Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 5000))]);
          }
        } catch {}
        // Request every image with CORS. This page has an opaque origin (it is
        // built with setContent), so an image fetched without crossOrigin
        // taints the canvas and toDataURL() throws — even for our own
        // /storage files. /storage answers with Access-Control-Allow-Origin: *.
        const markCors = (objs: any[]) => {
          for (const o of objs || []) {
            if (String(o?.type || "").toLowerCase() === "image") o.crossOrigin = "anonymous";
            if (o?.objects) markCors(o.objects);
          }
        };
        markCors(designJson?.objects);
        await canvas.loadFromJSON(designJson);
        const map = new Map<string, any>();
        const walk = (objs: any[], prefix: string) => {
          objs.forEach((o, i) => {
            const p = prefix ? `${prefix}.${i}` : `${i}`;
            if (o.mediaType === "video") {
              map.set(o.id || p, o);
              if (o.name) map.set(o.name, o);
              o.__originalOpacity = o.opacity ?? 1;
              o.objectCaching = false;
            }
            if (o.objects) walk(o.objects, p);
          });
        };
        walk(canvas.getObjects(), "");
        (window as any).__canoliteVideoMap = map;
        canvas.renderAll();
      },
      { designJson: renderJson, width: opts.width, height: opts.height, background: opts.background || renderJson?.background, families }
    );

    encoder = startMp4Encoder({
      outPath,
      width: evenWidth,
      height: evenHeight,
      fps: timeline.fps,
      crf: qualityToCrf(opts.quality),
      audioLayers: decoded.filter((d) => d.audioPath),
    });
    let encoderStderr = "";
    encoder.stderr.setEncoding("utf8");
    encoder.stderr.on("data", (chunk) => (encoderStderr += chunk));

    let firstPng: Buffer | null = null;
    for (let frameIdx = 0; frameIdx < timeline.frameCount; frameIdx += 1) {
      const updates = decoded.map((d) => ({
        layerId: d.layer.layerId,
        name: d.layer.name,
        url: frameUrlForFrame(d, timeline, frameIdx),
        boxW: d.layer.boxW,
        boxH: d.layer.boxH,
      }));
      const dataUrl: string = await page.evaluate(
        async ({ updates, scale }: any) => {
          const canvas = (window as any).__canoliteCanvas;
          const map: Map<string, any> = (window as any).__canoliteVideoMap;
          const loads: Promise<void>[] = [];
          for (const u of updates as any[]) {
            const obj = map.get(u.layerId) || map.get(u.name);
            if (!obj) continue;
            if (!u.url) {
              obj.opacity = 0;
              continue;
            }
            obj.opacity = obj.__originalOpacity ?? 1;
            loads.push(
              (async () => {
                // "anonymous", never null: a frame loaded without CORS taints
                // the canvas and every later toDataURL() fails.
                await obj.setSrc(u.url, { crossOrigin: "anonymous" });
                const el: any = obj.getElement?.() || obj._element;
                const nw = el?.naturalWidth || obj.width || 1;
                const nh = el?.naturalHeight || obj.height || 1;
                obj.set({ width: nw, height: nh, scaleX: u.boxW / nw, scaleY: u.boxH / nh, cropX: 0, cropY: 0 });
              })()
            );
          }
          await Promise.all(loads);
          canvas.renderAll();
          return canvas.toDataURL({ format: "png", multiplier: scale });
        },
        { updates, scale: outputScale }
      );
      const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
      if (!firstPng) firstPng = png;
      await writeWithBackpressure(encoder.stdin, png);
      if (frameIdx % 10 === 0 || frameIdx === timeline.frameCount - 1) {
        const progress = Math.min(99, Math.round(((frameIdx + 1) / timeline.frameCount) * 95));
        await opts.onProgress?.(progress);
      }
    }

    encoder.stdin.end();
    const [code] = (await once(encoder, "close")) as [number | null];
    encoder = null;
    if (code !== 0) throw new Error(`ffmpeg MP4 encode failed${encoderStderr.trim() ? `: ${encoderStderr.trim()}` : ""}`);
    await opts.onProgress?.(99);

    const buffer = await fs.readFile(outPath);
    const posterBuffer = firstPng ? await sharp(firstPng).jpeg({ quality: 85 }).toBuffer() : Buffer.alloc(0);
    return { buffer, posterBuffer, durationSec: timeline.durationSec, fps: timeline.fps, frameCount: timeline.frameCount, warnings };
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (encoder && !encoder.killed) encoder.kill("SIGKILL");
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
