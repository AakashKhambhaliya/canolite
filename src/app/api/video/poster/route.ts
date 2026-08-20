import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { storageFilePath, uploadFile } from "@/lib/storage";
import { extractPoster } from "@/lib/video/poster";
import { generateId } from "@/lib/utils";

function keyFromStorageUrl(url: string): string | null {
  const match = url.match(/^\/storage\/(.+)$/);
  return match ? match[1] : null;
}

export async function POST(request: Request) {
  let tempDir: string | null = null;

  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const assetId = String(body.assetId || "");
    const atSec = Number(body.atSec || 0);
    if (!assetId) {
      return NextResponse.json({ error: "assetId is required" }, { status: 400 });
    }
    if (!Number.isFinite(atSec) || atSec < 0) {
      return NextResponse.json({ error: "atSec must be a non-negative number" }, { status: 400 });
    }

    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.projectId, user.projectId)))
      .limit(1);

    if (!asset || asset.type !== "video") {
      return NextResponse.json({ error: "Video asset not found" }, { status: 404 });
    }

    const metadata = (asset.metadata || {}) as { durationSec?: number; duration?: number };
    const durationSec = Number(metadata.durationSec ?? metadata.duration ?? 0);
    if (Number.isFinite(durationSec) && durationSec > 0 && atSec > durationSec) {
      return NextResponse.json(
        { error: `atSec exceeds video duration (${durationSec} seconds)` },
        { status: 400 }
      );
    }

    const sourceKey = keyFromStorageUrl(asset.url);
    if (!sourceKey) {
      return NextResponse.json(
        { error: "Poster extraction currently requires a stored local video asset" },
        { status: 400 }
      );
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canolite-poster-"));
    const outPath = path.join(tempDir, "poster.jpg");
    await extractPoster(storageFilePath(sourceKey), atSec, outPath);

    const posterKey = `${sourceKey}.poster.${generateId()}.jpg`;
    const posterUrl = await uploadFile(posterKey, await fs.readFile(outPath), "image/jpeg");

    return NextResponse.json({ posterUrl });
  } catch (error) {
    console.error("Video poster error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
