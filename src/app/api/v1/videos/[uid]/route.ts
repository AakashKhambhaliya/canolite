import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";
import { absoluteForRequest } from "@/lib/storage";

export async function OPTIONS() {
  return handleOptions();
}

export async function GET(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  try {
    const { uid } = await params;
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);
    const [job] = await db.select().from(renderJobs).where(and(eq(renderJobs.uid, uid), eq(renderJobs.projectId, auth.projectId))).limit(1);
    if (!job || job.outputKind !== "video") return withCors(NextResponse.json({ error: "Video render job not found" }, { status: 404 }));
    return withCors(NextResponse.json({
      uid: job.uid,
      status: job.status,
      progress: job.progress || 0,
      video_url: absoluteForRequest(request, job.outputUrl || job.imageUrl),
      poster_url: absoluteForRequest(request, job.posterUrl),
      duration: job.durationSec,
      fps: job.fps,
      frame_count: job.frameCount,
      error: job.errorMessage || undefined,
      batch_uid: job.batchUid || undefined,
      created_at: job.createdAt,
      completed_at: job.completedAt,
    }));
  } catch (error) {
    console.error("Error fetching video render:", error);
    return withCors(NextResponse.json({ error: "Internal server error" }, { status: 500 }));
  }
}
