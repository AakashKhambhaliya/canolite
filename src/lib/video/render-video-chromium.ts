/**
 * Legacy video renderer: Chromium paints every output frame.
 *
 * This is the original pipeline — ffmpeg decodes each source clip to frames
 * on disk, a headless Chromium page swaps the video layers' sources frame by
 * frame and exports the whole canvas, and the PNGs are piped into an ffmpeg
 * encoder. It renders ANY design correctly (rotations, clips, groups,
 * filters…), which is why the fast path falls back to it, but the per-frame
 * browser round-trip makes it slow.
 */
import { promises as fs } from "fs";
import { once } from "events";
import path from "path";
import sharp from "sharp";
import { config } from "@/lib/config";
import { buildFontHead, getBrowser, getFabricSource, type CustomFontRef } from "@/lib/render/render-image";
import { sourceTimeForFrame } from "./timeline";
import { decodeLayerFrames, type DecodedLayer } from "./decode";
import { startMp4Encoder } from "./encode";
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

export async function renderVideoWithChromium(ctx: PreparedVideoRender): Promise<RenderVideoResult> {
  const { timeline, outputScale } = ctx;
  const storageTmpKey = `tmp/${ctx.uid}`;
  const tmpDir = ctx.tmpDir;
  let page: any;
  let encoder: ReturnType<typeof startMp4Encoder> | null = null;

  try {
    const decoded: DecodedLayer[] = [];
    for (const [index, layer] of timeline.layers.entries()) {
      decoded.push(await decodeLayerFrames({ layer, fps: timeline.fps, tmpDir, storageTmpKey, outputScale }));
      await ctx.onProgress?.(
        Math.round(((index + 1) / timeline.layers.length) * DECODE_PROGRESS_CEILING)
      );
    }

    const families = collectFamilies(ctx.designJson);
    const fontHead = buildFontHead(families, ctx.customFonts as CustomFontRef[]);
    const fabric = await getFabricSource();
    const browser = await getBrowser();
    page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(VIDEO_RENDER_TIMEOUT_MS);
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
        designJson: ctx.designJson,
        width: ctx.width,
        height: ctx.height,
        background: ctx.background || ctx.designJson?.background,
        families,
      }
    );

    // Design loaded in Chromium — the last silent step before encoding starts.
    await ctx.onProgress?.(PREP_PROGRESS_CEILING);

    encoder = startMp4Encoder({
      outPath: path.join(tmpDir, "out.mp4"),
      width: ctx.evenWidth,
      height: ctx.evenHeight,
      fps: timeline.fps,
      crf: ctx.crf,
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
        // Spans PREP_PROGRESS_CEILING..99 rather than 0..95, so encoding picks
        // up where preparation left off instead of jumping backwards to ~0 on
        // the first frame.
        const encoded = (frameIdx + 1) / timeline.frameCount;
        const progress = Math.min(
          99,
          PREP_PROGRESS_CEILING + Math.round(encoded * (99 - PREP_PROGRESS_CEILING))
        );
        await ctx.onProgress?.(progress);
      }
    }

    encoder.stdin.end();
    const [code] = (await once(encoder, "close")) as [number | null];
    encoder = null;
    if (code !== 0) throw new Error(`ffmpeg MP4 encode failed${encoderStderr.trim() ? `: ${encoderStderr.trim()}` : ""}`);
    await ctx.onProgress?.(99);

    const buffer = await fs.readFile(path.join(tmpDir, "out.mp4"));
    const posterBuffer = firstPng ? await sharp(firstPng).jpeg({ quality: 85 }).toBuffer() : Buffer.alloc(0);
    return { buffer, posterBuffer, durationSec: timeline.durationSec, fps: timeline.fps, frameCount: timeline.frameCount, warnings: ctx.warnings };
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (encoder && !encoder.killed) encoder.kill("SIGKILL");
  }
}
