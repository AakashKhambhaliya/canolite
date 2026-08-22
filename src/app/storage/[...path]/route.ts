import { NextResponse } from "next/server";
import { createReadStream, promises as fs } from "fs";
import { Readable } from "stream";
import path from "path";
import { storageFilePath } from "@/lib/storage";

/**
 * Serve stored files (rendered images, uploads) at /storage/<key>.
 *
 * We can't rely on Next's static serving of the `public/` folder for these:
 * files are written at *runtime* into a mounted volume, and several deploy
 * setups (standalone output, some buildpacks) don't serve runtime-added public
 * files — they 404. Reading the file from disk in an app route sidesteps all of
 * that and works regardless of how the image was built.
 *
 * Range requests are supported, which matters for video: a browser asks for
 * byte ranges to seek, and to start playing before the whole file has arrived.
 * Answering every request with the entire file (no Accept-Ranges, no
 * Content-Length) left the scrubber dead and made large clips slow to start.
 * Responses are streamed rather than buffered for the same reason — a 100MB
 * upload used to be read into memory in full on every single request.
 */

const MIME: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

/**
 * Parse a single-range `Range: bytes=start-end` header against a known size.
 *
 * Returns null when the header is absent or in a form we don't serve (multiple
 * ranges, or a non-`bytes` unit), in which case the caller sends the whole
 * file — a legal response to any range request. Returns "unsatisfiable" for a
 * syntactically valid range that falls outside the file, which must be a 416
 * rather than silently serving something else.
 */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // `bytes=-N` — the final N bytes.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return "unsatisfiable";

  return { start, end: Math.min(end, size - 1) };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: parts } = await params;
  const key = (parts || []).join("/");

  let filePath: string;
  try {
    // Traversal-checked: throws if the key escapes the storage root.
    filePath = storageFilePath(key);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  let size: number;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return new NextResponse("Not found", { status: 404 });
    size = stat.size;
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    // Keys are unique per render/upload, so the bytes never change.
    "Cache-Control": "public, max-age=31536000, immutable",
    // Advertised even on a full response — it is how a player learns it may
    // seek at all.
    "Accept-Ranges": "bytes",
    // NOTE: the security headers these bytes need — X-Content-Type-Options,
    // the SVG-only Content-Security-Policy that defuses stored XSS, and the
    // Access-Control-Allow-Origin the renderer relies on — are all declared on
    // the /storage entries in next.config.mjs `headers()`, not here. With
    // STORAGE_DIR at its default the files live under public/ and are served by
    // Next's STATIC handler, which never reaches this route, so anything set
    // only here would protect just the STORAGE_DIR deploys. Declaring them
    // there covers both paths with one rule; repeating them here would emit
    // each header twice.
  };

  const range = parseRange(req.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  // A zero-byte file has no satisfiable byte range; send an empty 200.
  const length = size === 0 ? 0 : end - start + 1;

  const stream = createReadStream(filePath, size === 0 ? {} : { start, end });

  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "Content-Length": String(length),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}
