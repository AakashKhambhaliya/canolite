/**
 * Inline custom font files before rendering.
 *
 * The render page is built with Playwright's `page.setContent()`, which gives
 * it an *opaque* ("null") origin. CSS font fetches are always CORS-mode — even
 * for same-site URLs — so a `@font-face` pointing at `/storage/<key>` is
 * blocked ("No 'Access-Control-Allow-Origin' header"), the FontFace ends up in
 * `status: "error"`, and Chromium silently paints a generic fallback face. That
 * is why an API/playground render lost the custom fonts that the editor (a
 * normal same-origin page) shows correctly.
 *
 * Images don't hit this — `<img>` loads aren't CORS-checked — which is why the
 * background art rendered fine while only the text fonts fell back.
 *
 * The fix is the same one already used for external images: resolve the bytes
 * server-side and hand the render page a `data:` URL, which no origin or CORS
 * policy can block. Stored fonts are read straight off disk; absolute URLs
 * (e.g. a future object-store backend) are fetched through the SSRF guard.
 *
 * A font that can't be resolved keeps its original URL: the render then degrades
 * exactly as it does today rather than failing outright.
 */
import { promises as fs } from "fs";
import path from "path";
import { storageFilePath } from "@/lib/storage";
import { safeFetch } from "@/lib/ssrf";
import type { CustomFontRef } from "./render-image";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FONT_BYTES = 10 * 1024 * 1024; // 10 MB

const FONT_MIME: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

function mimeForUrl(url: string): string {
  const ext = path.extname(url.split("?")[0]).slice(1).toLowerCase();
  return FONT_MIME[ext] || "application/octet-stream";
}

function toDataUrl(url: string, bytes: Buffer): string {
  return `data:${mimeForUrl(url)};base64,${bytes.toString("base64")}`;
}

/** Read a `/storage/<key>` URL off disk. */
async function readStoredFont(url: string): Promise<Buffer> {
  const key = decodeURIComponent(url.replace(/^\/storage\//, ""));
  // storageFilePath is traversal-checked and throws on a key that escapes root.
  return fs.readFile(storageFilePath(key));
}

async function fetchFont(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_FONT_BYTES) throw new Error("font is too large (max 10MB)");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replace every custom font URL with a self-contained `data:` URL so the fonts
 * survive the render page's opaque origin. Already-inlined fonts pass through.
 */
export async function inlineFontSources(
  fonts: CustomFontRef[]
): Promise<CustomFontRef[]> {
  return Promise.all(
    fonts.map(async (font) => {
      if (!font.url || font.url.startsWith("data:")) return font;
      try {
        const bytes = font.url.startsWith("/storage/")
          ? await readStoredFont(font.url)
          : await fetchFont(font.url);
        return { ...font, url: toDataUrl(font.url, bytes) };
      } catch (err: any) {
        console.error(
          `[render] Could not inline custom font "${font.family}" (${font.url}):`,
          err?.message || err
        );
        return font;
      }
    })
  );
}
