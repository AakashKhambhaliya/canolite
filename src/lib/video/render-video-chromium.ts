/**
 * Legacy video renderer: Chromium paints every output frame.
 *
 * This is the original pipeline — ffmpeg decodes each source clip to frames
 * on disk, headless Chromium pages swap the video layers' sources frame by
 * frame and export the canvas, and the frames are piped into an ffmpeg
 * encoder. It renders ANY design correctly (rotations, clips, groups,
 * filters…), which is why the fast path falls back to it, but the per-frame
 * browser round-trip makes it slow.
 *
 * Two speedups keep this path tolerable (output is pixel-identical modulo
 * JPEG quality):
 *  - frames are exported as quality-0.95 JPEG instead of PNG (the encode
 *    target is yuv420p, which has no alpha to preserve);
 *  - N pages render frames in parallel and an OrderedFramePipeline feeds the
 *    encoder strictly in frame order with bounded memory.
 */
import { promises as fs } from "fs";
import { once } from "events";
import os from "os";
import path from "path";
import sharp from "sharp";
import type { Page } from "playwright";
import { config } from "@/lib/config";
import { buildFontHead, getBrowser, getFabricSource, type CustomFontRef } from "@/lib/render/render-image";
import { sourceTimeForFrame } from "./timeline";
import { decodeLayerFrames, type DecodedLayer } from "./decode";
import { startMp4Encoder } from "./encode";
import { OrderedFramePipeline } from "./ordered-frame-pipeline";
import { createFrameRenderPool } from "./frame-pool";
import type { PreparedVideoRender, RenderVideoResult } from "./types";

/**
 * Progress budget for the preparation phase, before a single frame is encoded.
 * Frame decoding runs to DECODE_PROGRESS_CEILING, loading the design into
 * headless Chromium takes it to PREP_PROGRESS_CEILING, and encoding spans the
 * remainder. The split is a rough reflection of where the time actually goes;
 * its real job is to prove the render is alive.
 */
const DECODE_PROGRESS_CEILING = 12;
const PREP_PROGRESS_CEILING = 15;

const VIDEO_RENDER_TIMEOUT_MS = config.VIDEO_RENDER_TIMEOUT_MS;

/** Parallel render pages: VIDEO_FRAME_WORKERS, defaulting to the CPU count. */
export function frameWorkerCount(frameCount: number): number {
  const configured = config.VIDEO_FRAME_WORKERS > 0 ? config.VIDEO_FRAME_WORKERS : Math.max(1, os.cpus().length);
  return Math.max(1, Math.min(configured, frameCount));
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

async function writeWithBackpressure(stream: NodeJS.WritableStream, chunk: Buffer) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

function frameUrlForFrame(decoded: DecodedLayer, timeline: PreparedVideoRender["timeline"], frameIdx: number): string | null {
  const sourceTime = sourceTimeForFrame(decoded.layer, frameIdx, timeline.fps);
  if (sourceTime === null) return null;
  const rel = Math.max(0, sourceTime - decoded.layer.trimStart);
  const idx = Math.min(decoded.frameCount, Math.max(1, Math.floor(rel * timeline.fps) + 1));
  return `/storage/${decoded.framesDir}/${String(idx).padStart(6, "0")}.${decoded.frameExt}`;
}

/** One-time setup evaluated on every pool page (design, fonts, globals). */
export async function setupRenderPage(
  page: Page,
  params: { designJson: any; width: number; height: number; background: string | null; families: string[]; customFonts: CustomFontRef[] }
): Promise<void> {
  const fontHead = buildFontHead(params.families, params.customFonts);
  const fabric = await getFabricSource();
  const base = `http://127.0.0.1:${process.env.PORT || "3000"}`;
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><base href="${base}/">
     <style>html,body{margin:0;padding:0;background:#fff}</style>${fontHead}<script>/* Identity shim for esbuild-based runners (see render-image.ts). */window.__name = window.__name || (function (f) { return f; });</script><script>${fabric}</script></head>
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
    {
      designJson: params.designJson,
      width: params.width,
      height: params.height,
      background: params.background,
      families: params.families,
    }
  );
}

/** Render one output frame on one page and return the encoded frame buffer. */
export async function renderFrameOnPage(
  page: Page,
  params: {
    updates: Array<{ layerId: string; name: string; url: string | null; boxW: number; boxH: number }>;
    scale: number;
  }
): Promise<Buffer> {
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
      // JPEG, not PNG: the encoder's output is yuv420p (no alpha to keep),
      // and the JPEG payload is roughly an order of magnitude smaller, which
      // matters — every frame used to cross the CDP bridge as base64.
      return canvas.toDataURL({ format: "jpeg", quality: 0.95, multiplier: scale });
    },
    { updates: params.updates, scale: params.scale }
  );
  return Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64");
}

export async function renderVideoWithChromium(ctx: PreparedVideoRender): Promise<RenderVideoResult> {
  const { timeline, outputScale } = ctx;
  const storageTmpKey = `tmp/${ctx.uid}`;
  const tmpDir = ctx.tmpDir;
  const outPath = path.join(tmpDir, "out.mp4");
  let encoder: ReturnType<typeof startMp4Encoder> | null = null;
  let pool: Awaited<ReturnType<typeof createFrameRenderPool>> | null = null;

  try {
    const decoded: DecodedLayer[] = [];
    for (const [index, layer] of timeline.layers.entries()) {
      decoded.push(await decodeLayerFrames({ layer, fps: timeline.fps, tmpDir, storageTmpKey, outputScale }));
      await ctx.onProgress?.(Math.round(((index + 1) / timeline.layers.length) * DECODE_PROGRESS_CEILING));
    }

    // Design loaded into every pool page — the last silent step before
    // encoding starts.
    const families = collectFamilies(ctx.designJson);
    pool = await createFrameRenderPool({
      size: frameWorkerCount(timeline.frameCount),
      timeoutMs: VIDEO_RENDER_TIMEOUT_MS,
      setupPage: (page) =>
        setupRenderPage(page, {
          designJson: ctx.designJson,
          width: ctx.width,
          height: ctx.height,
          background: ctx.background || ctx.designJson?.background || null,
          families,
          customFonts: ctx.customFonts,
        }),
      renderOnPage: (page, frameIdx) =>
        renderFrameOnPage(page, {
          updates: decoded.map((d) => ({
            layerId: d.layer.layerId,
            name: d.layer.name,
            url: frameUrlForFrame(d, timeline, frameIdx),
            boxW: d.layer.boxW,
            boxH: d.layer.boxH,
          })),
          scale: outputScale,
        }),
    });
    await ctx.onProgress?.(PREP_PROGRESS_CEILING);

    encoder = startMp4Encoder({
      outPath,
      width: ctx.evenWidth,
      height: ctx.evenHeight,
      fps: timeline.fps,
      crf: ctx.crf,
      audioLayers: decoded.filter((d) => d.audioPath),
      frameFormat: "jpeg",
      encoder: ctx.encoder,
    });
    let encoderStderr = "";
    encoder.stderr.setEncoding("utf8");
    encoder.stderr.on("data", (chunk) => (encoderStderr += chunk));

    let firstFrame: Buffer | null = null;
    const pipeline = new OrderedFramePipeline<Buffer>({
      workerCount: pool.size,
      // workerId (not frameIdx) selects the page: the pipeline guarantees at
      // most one in-flight render per worker, and pages are stateful.
      produce: (frameIdx, workerId) => pool!.renderFrame(frameIdx, workerId),
      consume: async (frame, frameIdx) => {
        if (frameIdx === 0) firstFrame = frame;
        await writeWithBackpressure(encoder!.stdin, frame);
        if (frameIdx % 10 === 0 || frameIdx === timeline.frameCount - 1) {
          // Spans PREP_PROGRESS_CEILING..99 rather than 0..95, so encoding
          // picks up where preparation left off instead of jumping backwards.
          const encoded = (frameIdx + 1) / timeline.frameCount;
          const progress = Math.min(99, PREP_PROGRESS_CEILING + Math.round(encoded * (99 - PREP_PROGRESS_CEILING)));
          await ctx.onProgress?.(progress);
        }
      },
    });
    await pipeline.run(timeline.frameCount);

    encoder.stdin.end();
    const [code] = (await once(encoder, "close")) as [number | null];
    encoder = null;
    if (code !== 0) throw new Error(`ffmpeg MP4 encode failed${encoderStderr.trim() ? `: ${encoderStderr.trim()}` : ""}`);
    await ctx.onProgress?.(99);

    const buffer = await fs.readFile(outPath);
    const posterBuffer = firstFrame ? await sharp(firstFrame).jpeg({ quality: 85 }).toBuffer() : Buffer.alloc(0);
    return { buffer, posterBuffer, durationSec: timeline.durationSec, fps: timeline.fps, frameCount: timeline.frameCount, warnings: ctx.warnings };
  } finally {
    if (pool) await pool.close().catch(() => undefined);
    if (encoder && !encoder.killed) encoder.kill("SIGKILL");
  }
}
