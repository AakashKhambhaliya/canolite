import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createBatchJobs, createVideoBatchJobs } from "@/lib/render/create-job";
import { processBatch } from "@/lib/render/process-job";
import { processVideoBatch } from "@/lib/render/process-video-job";

/**
 * Dashboard batch render. Creates the jobs and processes them in the
 * background; the Renders page polls for status.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { template_id, items, format, quality, scale } = body;

    if (!template_id) {
      return NextResponse.json(
        { error: "template_id is required" },
        { status: 400 }
      );
    }
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: "items array is required and must not be empty" },
        { status: 400 }
      );
    }
    if (items.length > 500) {
      return NextResponse.json(
        { error: "Maximum 500 items per batch" },
        { status: 400 }
      );
    }
    if (format === "mp4") {
      if (items.length > 20) {
        return NextResponse.json({ error: "Maximum 20 items per video batch" }, { status: 400 });
      }
      const created = await createVideoBatchJobs({
        projectId: user.projectId,
        templateId: template_id,
        items,
        output: { fps: body.fps, durationSec: body.duration, quality: body.videoQuality || body.qualityPreset },
      });
      if (!created) return NextResponse.json({ error: "Template not found" }, { status: 404 });
      void processVideoBatch(created.uids);
      return NextResponse.json({
        batch_uid: created.batchUid,
        uids: created.uids,
        count: created.uids.length,
        status: "queued",
        template_id,
        format: "mp4",
      });
    }

    const created = await createBatchJobs({
      projectId: user.projectId,
      templateId: template_id,
      items,
      output: { format, quality, scale },
    });
    if (!created) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    void processBatch(created.uids);

    return NextResponse.json({
      batch_uid: created.batchUid,
      uids: created.uids,
      count: created.uids.length,
      status: "queued",
      template_id,
      format: created.resolved.format,
      quality: created.resolved.quality,
      scale: created.resolved.scale,
    });
  } catch (error) {
    console.error("Error creating batch:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
