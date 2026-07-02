import { NextResponse } from "next/server";
import { promises as fs } from "fs";
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
 */

const MIME: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

export async function GET(
  _req: Request,
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

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();

    const headers: Record<string, string> = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // Keys are unique per render/upload, so the bytes never change.
      "Cache-Control": "public, max-age=31536000, immutable",
      // Never let the browser MIME-sniff user-supplied bytes into something
      // executable.
      "X-Content-Type-Options": "nosniff",
    };

    // SVGs served inline from our own origin are a stored-XSS vector: a crafted
    // <svg> can carry <script>/onload handlers that run in this origin's
    // context. Neutralize them with a locked-down CSP + a sandbox that blocks
    // scripts, so an <img src>/<object> still renders the drawing but never
    // executes code. (Raster formats can't execute, so they're unaffected.)
    if (ext === "svg") {
      headers["Content-Security-Policy"] =
        "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }

    return new NextResponse(new Uint8Array(data), { status: 200, headers });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
