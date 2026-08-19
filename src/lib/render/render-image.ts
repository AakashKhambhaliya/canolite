/**
 * Render engine (Phase 1 — implemented).
 *
 * Renders a Fabric.js design JSON to an image by loading it into a real
 * headless Chromium page (via Playwright) and exporting the canvas, then
 * post-processing format/quality with Sharp. This is the path described in
 * the architecture: apply mods → Fabric in Chromium → export → Sharp.
 */
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import type { Browser } from "playwright";
import googleFontsRaw from "@/lib/editor/google-fonts.json";

interface GoogleFontMeta {
  family: string;
  weights: number[];
}
const GOOGLE_FONT_META = new Map(
  (googleFontsRaw as GoogleFontMeta[]).map((f) => [f.family, f.weights])
);

export interface CustomFontRef {
  family: string;
  url: string;
}

// Collect every fontFamily referenced in a design (recursing into groups).
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

/**
 * Build <head> markup that makes the design's fonts available in Chromium.
 *
 * Custom font URLs must already be inlined as `data:` URLs (see
 * `inlineFontSources`) — the render page has an opaque origin, so a network URL
 * here is blocked by CORS and falls back to a generic face.
 */
export function buildFontHead(families: string[], customFonts: CustomFontRef[]): string {
  const customByFamily = new Map(customFonts.map((f) => [f.family, f.url]));
  const parts: string[] = [];
  for (const family of families) {
    if (customByFamily.has(family)) {
      parts.push(
        `@font-face{font-family:'${family}';src:url('${customByFamily.get(
          family
        )}');font-display:block;}`
      );
    } else if (GOOGLE_FONT_META.has(family)) {
      const weights = (GOOGLE_FONT_META.get(family) || [400, 700]).join(";");
      const param = family.replace(/ /g, "+");
      parts.push(
        `@import url('https://fonts.googleapis.com/css2?family=${param}:wght@${weights}&display=block');`
      );
    }
  }
  return parts.length ? `<style>${parts.join("\n")}</style>` : "";
}

// Inline the Fabric browser build into the render page once.
let fabricSource: string | null = null;
async function getFabricSource(): Promise<string> {
  if (fabricSource) return fabricSource;
  const p = path.join(process.cwd(), "node_modules", "fabric", "dist", "index.min.js");
  fabricSource = await fs.readFile(p, "utf8");
  return fabricSource;
}

// Reuse a single Chromium instance across renders (cached over HMR).
const globalForBrowser = globalThis as unknown as {
  __canoliteBrowser?: Browser;
  __canoliteBrowserPromise?: Promise<Browser>;
};

async function getBrowser(): Promise<Browser> {
  if (globalForBrowser.__canoliteBrowser?.isConnected()) {
    return globalForBrowser.__canoliteBrowser;
  }
  // Cache the in-flight launch *promise* synchronously (before the first
  // `await`), not just the resolved browser — otherwise two renders arriving
  // concurrently during a cold start (or right after the cached browser
  // dies) both see no browser cached and both launch their own Chromium
  // instance; the second assignment below would silently orphan the first
  // browser's process (never closed, never referenced again). Mirrors
  // ensureDb()'s pattern in src/db/index.ts.
  if (!globalForBrowser.__canoliteBrowserPromise) {
    globalForBrowser.__canoliteBrowserPromise = (async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      });
      globalForBrowser.__canoliteBrowser = browser;
      return browser;
    })().finally(() => {
      // Clear once settled: on success, future calls take the fast path
      // above via __canoliteBrowser; on failure, this lets the next call
      // retry the launch instead of permanently reusing a rejected promise.
      globalForBrowser.__canoliteBrowserPromise = undefined;
    });
  }
  return globalForBrowser.__canoliteBrowserPromise;
}

/**
 * Hard ceiling on a single render. `page.evaluate()` has no timeout of its own
 * and is not covered by Playwright's default timeouts, so a design that makes
 * fabric's loadFromJSON never settle would hang forever: the job stays
 * "processing" for good, its page is never closed, and it holds one of the
 * worker's RENDER_CONCURRENCY slots permanently. Enough of those and rendering
 * stops entirely until someone restarts the process.
 */
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 60_000);

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} after ${Math.round(ms / 1000)}s`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export interface RenderOptions {
  designJson: any;
  width: number;
  height: number;
  format?: "png" | "jpg" | "jpeg" | "webp";
  quality?: number;
  scale?: number;
  background?: string;
  customFonts?: CustomFontRef[];
}

export interface RenderResult {
  buffer: Buffer;
  contentType: string;
  ext: string;
}

export async function renderToBuffer(opts: RenderOptions): Promise<RenderResult> {
  const {
    designJson,
    width,
    height,
    format = "png",
    quality = 90,
    scale = 1,
    background,
    customFonts = [],
  } = opts;

  const families = collectFamilies(designJson);
  const fontHead = buildFontHead(families, customFonts);
  const fabric = await getFabricSource();
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 16, height: 16 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(RENDER_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);

  try {
    // <base> lets relative storage URLs (/storage/...) in the design and fonts
    // resolve inside the headless page. Point it at the app's own local listen
    // address so it works on whatever port the server runs on (no APP_URL needed).
    const base = `http://127.0.0.1:${process.env.PORT || "3000"}`;
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8">
       <base href="${base}/">
       <style>html,body{margin:0;padding:0;background:#fff}</style>
       ${fontHead}
       <script>${fabric}</script></head>
       <body><canvas id="c"></canvas></body></html>`,
      { waitUntil: "load" }
    );

    const renderInPage = page.evaluate(
      async ({ designJson, width, height, scale, background, families }) => {
        // @ts-ignore — fabric is injected globally
        const f = (window as any).fabric;
        const el = document.getElementById("c") as HTMLCanvasElement;
        const canvas = new f.StaticCanvas(el, {
          width,
          height,
          enableRetinaScaling: false,
        });
        if (background) canvas.backgroundColor = background;

        // Make sure every referenced font is actually loaded before drawing.
        try {
          const fonts: any = (document as any).fonts;
          if (fonts) {
            await Promise.all(
              (families as string[]).map((fam) =>
                fonts.load(`16px "${fam}"`).catch(() => {})
              )
            );
            await Promise.race([
              fonts.ready,
              new Promise((r) => setTimeout(r, 5000)),
            ]);
          }
        } catch {}

        await canvas.loadFromJSON(designJson);
        canvas.renderAll();

        canvas.renderAll();
        return canvas.toDataURL({ format: "png", multiplier: scale });
      },
      {
        designJson,
        width,
        height,
        scale,
        background: background || designJson?.background,
        families,
      }
    );

    // Bound the in-page work — page.evaluate() has no timeout of its own.
    const dataUrl: string = await withTimeout(
      renderInPage,
      RENDER_TIMEOUT_MS,
      "Render timed out"
    );

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const pngBuffer = Buffer.from(base64, "base64");

    // Post-process format / quality with Sharp.
    const norm = format === "jpeg" ? "jpg" : format;
    let pipeline = sharp(pngBuffer);
    let contentType = "image/png";
    let ext = "png";

    if (norm === "jpg") {
      pipeline = pipeline
        .flatten({ background: background || "#ffffff" })
        .jpeg({ quality });
      contentType = "image/jpeg";
      ext = "jpg";
    } else if (norm === "webp") {
      pipeline = pipeline.webp({ quality });
      contentType = "image/webp";
      ext = "webp";
    } else {
      pipeline = pipeline.png();
    }

    const buffer = await pipeline.toBuffer();
    return { buffer, contentType, ext };
  } finally {
    // Never let a close failure replace the real error — and on the timeout
    // path this is what actually tears down the runaway page.
    await page.close().catch(() => {});
  }
}
