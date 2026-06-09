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
 */
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

async function fetchAsDataUrl(url: string): Promise<string> {
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

  return `data:${type};base64,${buf.toString("base64")}`;
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

  const resolved = new Map<string, string>();
  await Promise.all(
    Array.from(urls).map(async (url) => {
      resolved.set(url, await fetchAsDataUrl(url));
    })
  );

  const apply = (objects: any[]) => {
    for (const obj of objects || []) {
      if ((obj?.type || "").toLowerCase() === "image" && resolved.has(obj.src)) {
        obj.src = resolved.get(obj.src);
      }
      if (obj?.objects) apply(obj.objects);
    }
  };
  apply(json.objects || []);

  return json;
}
