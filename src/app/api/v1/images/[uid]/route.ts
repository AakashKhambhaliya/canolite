import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";
import { absoluteForRequest } from "@/lib/storage";

export async function OPTIONS() {
  return handleOptions();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ uid: string }> }
) {
  try {
    const { uid } = await params;
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    if (!uid || uid.length < 4) {
      return withCors(
        NextResponse.json({ error: "Invalid uid" }, { status: 400 })
      );
    }

    const [job] = await db
      .select()
      .from(renderJobs)
      .where(
        and(
          eq(renderJobs.uid, uid),
          eq(renderJobs.projectId, auth.projectId)
        )
      )
      .limit(1);

    if (!job) {
      return withCors(
        NextResponse.json(
          { error: "Render job not found" },
          { status: 404 }
        )
      );
    }

    return withCors(
      NextResponse.json({
        uid: job.uid,
        status: job.status,
        image_url: absoluteForRequest(request, job.imageUrl),
        format: job.format,
        quality: job.quality,
        scale: job.scale,
        duration_ms: job.durationMs,
        error: job.errorMessage || undefined,
        batch_uid: job.batchUid || undefined,
        created_at: job.createdAt,
        completed_at: job.completedAt,
      })
    );
  } catch (error) {
    console.error("Error fetching render:", error);
    return withCors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 })
    );
  }
}
