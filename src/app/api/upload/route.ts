import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { uploadFile } from "@/lib/storage";
import { generateId } from "@/lib/utils";
import { config } from "@/lib/config";
import { probeVideo, type VideoProbeResult } from "@/lib/video/probe";
import { extractPoster } from "@/lib/video/poster";

const MAX_UPLOAD_MB = config.MAX_UPLOAD_MB;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_VIDEO_UPLOAD_MB = config.MAX_VIDEO_UPLOAD_MB;
const MAX_VIDEO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_MB * 1024 * 1024;
const MAX_VIDEO_DURATION_SEC = config.MAX_VIDEO_DURATION_SEC;
const MAX_VIDEO_PIXELS = config.MAX_VIDEO_PIXELS;

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "application/x-font-ttf": "ttf",
  "application/x-font-otf": "otf",
};

export async function POST(request: Request) {
  let tempDir: string | null = null;

  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // A body larger than `experimental.middlewareClientMaxBodySize` arrives
    // TRUNCATED rather than rejected, and multipart parsing then fails on the
    // incomplete payload. Report that as "too large" — the size checks below
    // never get the chance, because the bytes they would measure are gone.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        {
          error:
            `Upload failed: the request body could not be read, usually because the file ` +
            `exceeds the server's request size limit (currently ${MAX_VIDEO_UPLOAD_MB}MB for ` +
            `video, ${MAX_UPLOAD_MB}MB otherwise).`,
        },
        { status: 413 }
      );
    }

    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    // Validate type
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      return NextResponse.json(
        {
          error: `File type "${file.type}" not allowed. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}`,
        },
        { status: 400 }
      );
    }

    const isVideo = file.type.startsWith("video/");
    const maxBytes = isVideo ? MAX_VIDEO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
    const maxMb = isVideo ? MAX_VIDEO_UPLOAD_MB : MAX_UPLOAD_MB;

    // Validate size
    if (file.size > maxBytes) {
      return NextResponse.json(
        { error: `File too large. Maximum ${maxMb}MB.` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // Sanitize the filename — never trust it for a filesystem path.
    const base = (file.name || "file").split(/[/\\]/).pop() || "file";
    let safeName = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
    if (!safeName || safeName === "." || safeName === "..") safeName = `file.${ext}`;
    if (!safeName.toLowerCase().endsWith(`.${ext}`)) safeName = `${safeName}.${ext}`;
    const key = `uploads/${user.projectId}/${generateId()}/${safeName}`;

    let videoProbe: VideoProbeResult | null = null;
    let posterBuffer: Buffer | null = null;
    let posterUrl: string | null = null;

    if (isVideo) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canolite-upload-"));
      const tempInput = path.join(tempDir, safeName);
      const tempPoster = path.join(tempDir, `${safeName}.poster.jpg`);
      await fs.writeFile(tempInput, buffer);

      try {
        videoProbe = await probeVideo(tempInput);
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Could not inspect uploaded video.",
          },
          { status: 400 }
        );
      }

      if (videoProbe.durationSec <= 0 || videoProbe.width <= 0 || videoProbe.height <= 0) {
        return NextResponse.json(
          { error: "Video metadata is invalid or incomplete." },
          { status: 400 }
        );
      }

      if (videoProbe.durationSec > MAX_VIDEO_DURATION_SEC) {
        return NextResponse.json(
          {
            error: `Video too long. Maximum duration is ${MAX_VIDEO_DURATION_SEC} seconds.`,
          },
          { status: 400 }
        );
      }

      if (videoProbe.width * videoProbe.height > MAX_VIDEO_PIXELS) {
        return NextResponse.json(
          {
            error: `Video resolution too large. Maximum is ${MAX_VIDEO_PIXELS} pixels.`,
          },
          { status: 400 }
        );
      }

      await extractPoster(tempInput, 0, tempPoster);
      posterBuffer = await fs.readFile(tempPoster);
      posterUrl = await uploadFile(`${key}.poster.jpg`, posterBuffer, "image/jpeg");
    }

    const url = await uploadFile(key, buffer, file.type);

    const metadata = videoProbe
      ? {
          posterUrl,
          durationSec: videoProbe.durationSec,
          width: videoProbe.width,
          height: videoProbe.height,
          fps: videoProbe.fps,
          hasAudio: videoProbe.hasAudio,
          codec: videoProbe.codec,
          rotation: videoProbe.rotation,
        }
      : null;

    // Save asset record
    const [asset] = await db
      .insert(assets)
      .values({
        projectId: user.projectId,
        // The SANITIZED name, not the raw client-supplied one. For fonts this
        // column is what /api/fonts turns into a CSS font-family (name minus
        // extension), which then lands in a @font-face rule in the headless
        // render page — so a name carrying quotes or markup is an injection
        // source. buildFontHead escapes it too; storing it clean means the
        // family the editor registers and the one the renderer declares stay
        // identical instead of diverging at escape time.
        name: safeName,
        url,
        type: isVideo ? "video" : file.type.startsWith("image") ? "image" : "font",
        mimeType: file.type,
        size: file.size,
        metadata,
      })
      .returning();

    return NextResponse.json(
      {
        id: asset.id,
        url: asset.url,
        name: asset.name,
        type: asset.type,
        size: asset.size,
        ...(videoProbe
          ? {
              posterUrl,
              duration: videoProbe.durationSec,
              width: videoProbe.width,
              height: videoProbe.height,
              hasAudio: videoProbe.hasAudio,
              fps: videoProbe.fps,
              codec: videoProbe.codec,
              rotation: videoProbe.rotation,
            }
          : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
