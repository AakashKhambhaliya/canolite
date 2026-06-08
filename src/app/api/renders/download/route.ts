import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { Readable } from "stream";
import { ZipArchive } from "archiver";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { storageFilePath } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/renders/download[?batch=<batchUid>]
 *
 * Streams a ZIP of completed render images for the current project. With a
 * `batch` query it zips just that batch (e.g. a CSV bulk run); otherwise it
 * zips all completed renders. Used by the "Download ZIP" button.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const batch = new URL(request.url).searchParams.get("batch");

  const where = batch
    ? and(
        eq(renderJobs.projectId, user.projectId),
        eq(renderJobs.batchUid, batch),
        eq(renderJobs.status, "done")
      )
    : and(
        eq(renderJobs.projectId, user.projectId),
        eq(renderJobs.status, "done")
      );

  const jobs = await db
    .select({ uid: renderJobs.uid, imageUrl: renderJobs.imageUrl })
    .from(renderJobs)
    .where(where)
    .orderBy(asc(renderJobs.createdAt))
    .limit(2000);

  // Resolve each render's file on disk.
  const files: { path: string; name: string }[] = [];
  let idx = 1;
  for (const job of jobs) {
    if (!job.imageUrl) continue;
    const m = job.imageUrl.match(/\/storage\/(.+)$/);
    if (!m) continue;
    let fp: string;
    try {
      fp = storageFilePath(m[1]);
      await fs.access(fp);
    } catch {
      continue;
    }
    const ext = (m[1].split(".").pop() || "png").toLowerCase();
    files.push({
      path: fp,
      name: `${String(idx).padStart(4, "0")}_${job.uid}.${ext}`,
    });
    idx++;
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: "No completed renders to download yet" },
      { status: 404 }
    );
  }

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", (err) => {
    console.error("[download] zip error:", err);
    archive.destroy();
  });
  for (const f of files) archive.file(f.path, { name: f.name });
  void archive.finalize();

  const filename = batch ? `canolite-batch-${batch}.zip` : "canolite-renders.zip";
  return new Response(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
