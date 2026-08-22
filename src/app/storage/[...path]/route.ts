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
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
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
      // NOTE: the security headers these bytes need — X-Content-Type-Options,
      // the locked-down Content-Security-Policy that defuses SVG stored XSS,
      // and the Access-Control-Allow-Origin the renderer relies on — are all
      // declared on the /storage entry in next.config.mjs `headers()`, not
      // here. With STORAGE_DIR at its default the files live under public/ and
      // are served by Next's STATIC handler, which never reaches this route,
      // so anything set only here protected just the STORAGE_DIR deploys.
      // Declaring them there covers both paths with one rule; repeating them
      // here would emit each header twice.
    };

    return new NextResponse(new Uint8Array(data), { status: 200, headers });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
