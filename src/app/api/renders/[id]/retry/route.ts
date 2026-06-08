import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { processRenderJob } from "@/lib/render/process-job";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Reset the job to queued
    const [job] = await db
      .update(renderJobs)
      .set({
        status: "queued",
        errorMessage: null,
        completedAt: null,
        durationMs: null,
        imageUrl: null,
      })
      .where(
        and(
          eq(renderJobs.id, params.id),
          eq(renderJobs.projectId, user.projectId)
        )
      )
      .returning();

    if (!job) {
      return NextResponse.json(
        { error: "Render job not found" },
        { status: 404 }
      );
    }

    // Re-process the render in the background.
    void processRenderJob(job.uid);

    return NextResponse.json({ success: true, uid: job.uid });
  } catch (error) {
    console.error("Error retrying render:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
