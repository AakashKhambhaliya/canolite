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
import { isUrlSafe } from "@/lib/ssrf";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB
const FETCH_TIMEOUT_MS = 15_000;

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
  const head = buf.toString("utf8", 0, Math.min(buf.length, 256)).trim().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return null;
}

interface FetchedImage {
  dataUrl: string;
  /** Intrinsic pixel dimensions, when they could be determined. */
  width?: number;
  height?: number;
}

async function fetchImage(url: string): Promise<FetchedImage> {
  if (!(await isUrlSafe(url))) {
    throw new Error(`Image URL is not allowed: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Some hosts (incl. Google Drive) reject requests without a UA.
        "User-Agent":
          "Mozilla/5.0 (compatible; CanoliteRenderer/1.0; +https://github.com/canolite)",
        Accept: "image/*,*/*;q=0.8",
      },
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Timed out fetching image: ${url}`);
    }
    throw new Error(`Failed to fetch image: ${url}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch image (HTTP ${res.status}): ${url}`);
  }

  const lenHeader = res.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (max 25MB): ${url}`);
  }

  const contentType = (res.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());

  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (max 25MB): ${url}`);
  }

  const type = contentType.startsWith("image/") ? contentType : sniffImageType(buf);
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

  return { dataUrl: `data:${type};base64,${buf.toString("base64")}`, width, height };
}

/**
 * Walk a design JSON, fetch every external image src once, and return a clone
 * with those sources replaced by inlined data: URLs. Throws if a referenced
 * image can't be fetched (the caller records this on the render job).
 */
export async function inlineExternalImages(designJson: any): Promise<any> {
  const json = JSON.parse(JSON.stringify(designJson));

  const urls = new Set<string>();
  const collect = (objects: any[]) => {
    for (const obj of objects || []) {
      if ((obj?.type || "").toLowerCase() === "image" && isExternalHttp(obj.src)) {
        urls.add(obj.src);
      }
      if (obj?.objects) collect(obj.objects);
    }
  };
  collect(json.objects || []);

  if (urls.size === 0) return json;

  const resolved = new Map<string, FetchedImage>();
  await Promise.all(
    Array.from(urls).map(async (url) => {
      resolved.set(url, await fetchImage(url));
    })
  );

  const apply = (objects: any[]) => {
    for (const obj of objects || []) {
      if ((obj?.type || "").toLowerCase() === "image" && resolved.has(obj.src)) {
        const img = resolved.get(obj.src)!;

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
      if (obj?.objects) apply(obj.objects);
    }
  };
  apply(json.objects || []);

  return json;
}
