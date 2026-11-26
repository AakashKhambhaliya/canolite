import { renderSignal } from "@/lib/security/render-budget";
/**
 * Inline external image sources before rendering.
 *
 * The render page loads images *inside* headless Chromium. Arbitrary external
 * URLs (Google Drive share links, hotlink-protected hosts, anything without CORS
 * headers, or URLs that redirect to an HTML page) fail to load there with a bare
 * "fabric: Error loading <url>". To make user-supplied `image_url`s reliable, we
 * fetch them on the server — following redirects, sending a browser-like
 * User-Agent, and applying the SSRF guard — then swap the layer `src` for a
 * `data:` URL the browser can always load.
 *
 * Same-origin / root-relative `/storage/...` sources are left untouched: they
 * already resolve against the render page's <base> and load without issue.
 *
 * We also re-fit each swapped image to its layer's box. A modification only
 * changes `src`, leaving the scaleX/scaleY that were computed for the template's
 * *original* image — so a differently-sized replacement would render at the
 * wrong size. Using the fetched image's real dimensions, we recompute
 * scaleX/scaleY to stretch it to exactly fill the original layer box, so the
 * API result matches the template.
 */
import sharp from "sharp";
import { fetchPublic } from "@/lib/ssrf";
import type { ImageDesignObject } from "@/lib/design/types";
import { isImage } from "@/lib/design/predicates";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Root-relative path for an absolute URL pointing at THIS app's own /storage,
 * or null if it points anywhere else.
 *
 * Fabric serializes an image's `src` from the underlying DOM element, so the
 * browser has already absolutized it by the time a design is saved: a poster
 * added as "/storage/uploads/…jpg" gets stored as
 * "http://localhost:3000/storage/uploads/…jpg". Those are our own files, but
 * they arrive here looking external, so they were fetched over HTTP — and the
 * SSRF guard rightly refuses loopback, failing the render with "Failed to fetch
 * image". Normalising them back to root-relative lets the render page load them
 * via its <base>, like every other stored image. (Plain images escape this
 * because the editor inlines them as data: URLs; video posters are the path
 * that actually hit it.)
 */
export function selfStoragePath(src: unknown): string | null {
  if (typeof src !== "string" || !/^https?:\/\//i.test(src)) return null;

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith("/storage/")) return null;

  let appOrigin: string | null = null;
  try {
    appOrigin = new URL(process.env.APP_URL || "http://localhost:3000").origin;
  } catch {
    appOrigin = null;
  }

  // Loopback on any port counts as ourselves: dev servers move ports, and
  // APP_URL is often left at its default while the app runs on another one.
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";

  if (url.origin !== appOrigin && !isLoopback) return null;
  return url.pathname;
}

/** True for absolute http(s) URLs we should fetch & inline (not data: or /storage). */
function isExternalHttp(src: unknown): src is string {
  if (typeof src !== "string" || !src) return false;
  if (src.startsWith("data:")) return false;
  if (src.startsWith("/")) return false; // root-relative → resolves via <base>
  return /^https?:\/\//i.test(src);
}

/** Best-effort content-type from the first bytes when the server is unhelpful. */
function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "image/jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp" && /^avi[fs]$/.test(buf.toString("ascii", 8, 12)))
    return "image/avif";
  const head = buf.toString("utf8", 0, Math.min(buf.length, 256)).trim().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return null;
}

interface FetchedImage {
  byteLength: number;
  dataUrl: string;
  /** Intrinsic pixel dimensions, when they could be determined. */
  width?: number;
  height?: number;
}

async function fetchImage(url: string, maxBytes: number): Promise<FetchedImage> {
  const res = await fetchPublic(url, { signal: renderSignal(), timeoutMs: FETCH_TIMEOUT_MS, maxBytes,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CanoliteRenderer/1.0)", Accept: "image/*,*/*;q=0.8" } });
  if (!res.ok) throw new Error(`Remote image returned HTTP ${res.status}`);
  const contentType = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const buf = res.bytes;
  // The type comes from the BYTES, not the server's Content-Type: any
  // "image/*" header used to be trusted, so formats sharp can't measure (RLE
  // BMP, ICO, ...) skipped the pixel budget below and went straight into
  // Chromium. Only formats we can identify by magic bytes are accepted; an
  // SVG may also be recognised by its declared type plus an <svg> element
  // (it can open with a comment or doctype).
  const declaredSvg =
    contentType === "image/svg+xml" &&
    /<svg[s>]/i.test(buf.toString("utf8", 0, Math.min(buf.length, 4096)));
  const type = sniffImageType(buf) ?? (declaredSvg ? "image/svg+xml" : null);
  if (!type && contentType.startsWith("image/")) {
    throw new Error(`Unsupported image format "${contentType}". Use PNG, JPEG, WebP, GIF, AVIF or SVG.`);
  }
  if (!type) {
    throw new Error(
      `URL did not return an image (got "${contentType || "unknown"}"). ` +
        `If this is a Google Drive link, make sure the file is shared publicly ` +
        `("Anyone with the link") and use a direct image URL.`
    );
  }

  // Read the real pixel dimensions so the layer can be re-fitted to its box.
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(buf).metadata();
    if (meta.width && meta.height) {
      width = meta.width;
      height = meta.height;
    }
  } catch {
    // Non-raster (e.g. some SVGs) — fall back to no re-fit.
  }

  // A raster image whose size can't be read can't be held to the budget, so
  // it is rejected rather than trusted. (SVG is vector: its bytes are capped
  // and it is drawn at the layer's size.)
  if (type !== "image/svg+xml" && !(width && height)) throw new Error("Could not verify remote image dimensions");
  if (width && height && (width * height > 32_000_000 || Math.max(width,height) > 16384)) throw new Error("Remote image exceeds pixel budget");
  return { byteLength: buf.length, dataUrl: `data:${type};base64,${buf.toString("base64")}`, width, height };
}

/**
 * Walk a design JSON, fetch every external image src once, and return a clone
 * with those sources replaced by inlined data: URLs. Throws if a referenced
 * image can't be fetched (the caller records this on the render job).
 */
export async function inlineExternalImages(designJson: any): Promise<any> {
  const json = JSON.parse(JSON.stringify(designJson));

  // Group children, clip paths, and canvas-level images all use the same
  // storage and CORS rules. Background-only art must render, too.
  const images: ImageDesignObject[] = [];
  const collect = (o: any) => {
    if (!o || typeof o !== "object") return;
    if (isImage(o)) images.push(o);
    if (Array.isArray(o.objects)) o.objects.forEach(collect);
    for (const key of ["backgroundImage", "overlayImage", "clipPath"]) collect(o[key]);
  };
  collect(json);
  const urls = new Set<string>();
  for (const obj of images) {
    obj.crossOrigin = "anonymous";
    const relative = selfStoragePath(obj.src);
    if (relative) obj.src = relative;
    if (isExternalHttp(obj.src)) urls.add(obj.src);
  }

  if (urls.size === 0) return json;

  const resolved = new Map<string, FetchedImage>();
  if (urls.size > 64) throw new Error("Too many external media sources in one render");
  let remaining = 64 * 1024 * 1024;
  for (const url of urls) {
    const image = await fetchImage(url, Math.min(MAX_IMAGE_BYTES, remaining));
    remaining -= image.byteLength;
    resolved.set(url, image);
  }

  for (const obj of images) {
    const src = obj.src;
    if (src && resolved.has(src)) {
      const img = resolved.get(src)!;

      // Box the template laid out for the original image (display size).
      const boxW = (obj.width || 0) * (obj.scaleX ?? 1);
      const boxH = (obj.height || 0) * (obj.scaleY ?? 1);

      obj.src = img.dataUrl;

      // Stretch the replacement to fill exactly that box, so the API result
      // matches the template regardless of the new image's aspect ratio.
      if (img.width && img.height && boxW > 0 && boxH > 0) {
        obj.width = img.width;
        obj.height = img.height;
        obj.scaleX = boxW / img.width;
        obj.scaleY = boxH / img.height;
        // Drop any crop carried over from the original image.
        obj.cropX = 0;
        obj.cropY = 0;
      }
    }
  }

  return json;
}
