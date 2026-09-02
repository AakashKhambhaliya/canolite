import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { createRenderJob, createVideoRenderJob } from "@/lib/render/create-job";
import { processRenderJob } from "@/lib/render/process-job";
import { processVideoJob } from "@/lib/render/process-video-job";

/**
 * Dashboard render (Playground): creates a job and renders it synchronously so
 * the UI gets the image back immediately.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { template_id, modifications, format, quality, scale } = body;
    if (!template_id) {
      return NextResponse.json(
        { error: "template_id is required" },
        { status: 400 }
      );
    }

    if (format === "mp4") {
      const created = await createVideoRenderJob({
        projectId: user.projectId,
        templateId: template_id,
        modifications,
        output: {
          fps: body.fps,
          durationSec: body.duration,
          quality: body.videoQuality || body.qualityPreset,
          // Scale was dropped here, so an MP4 exported at 2x from the editor
          // silently rendered at 1x.
          scale,
        },
      });
      if (!created) return NextResponse.json({ error: "Template not found" }, { status: 404 });
      void processVideoJob(created.job.uid);
      return NextResponse.json({
        uid: created.job.uid,
        status: "queued",
        template_id,
        format: "mp4",
        progress: 0,
        warnings: created.warnings,
        created_at: created.job.createdAt,
      }, { status: 202 });
    }

    const created = await createRenderJob({
      projectId: user.projectId,
      templateId: template_id,
      modifications,
      output: { format, quality, scale },
    });
    if (!created) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    await processRenderJob(created.job.uid);

    const [finished] = await db
      .select()
      .from(renderJobs)
      .where(eq(renderJobs.uid, created.job.uid))
      .limit(1);

    return NextResponse.json({
      uid: created.job.uid,
      status: finished?.status || "done",
      template_id,
      format: created.resolved.format,
      quality: created.resolved.quality,
      scale: created.resolved.scale,
      image_url: finished?.imageUrl,
      error: finished?.errorMessage || undefined,
      warnings: created.warnings,
      created_at: created.job.createdAt,
    });
  } catch (error) {
    console.error("Error creating render:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
