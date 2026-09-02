import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";
import { videoRenderRequestSchema } from "@/lib/validation";
import { createVideoRenderJob } from "@/lib/render/create-job";
import { processVideoJob } from "@/lib/render/process-video-job";
import { isUrlSafe } from "@/lib/ssrf";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    const parsed = videoRenderRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return withCors(NextResponse.json({ error: "Validation error", details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }, { status: 400 }));
    }
    const { template_id, modifications, fps, duration, quality, scale, webhook_url } = parsed.data;
    if (webhook_url && !(await isUrlSafe(webhook_url))) {
      return withCors(NextResponse.json({ error: "webhook_url must be a public http(s) URL" }, { status: 400 }));
    }

    const created = await createVideoRenderJob({
      projectId: auth.projectId,
      templateId: template_id,
      modifications,
      output: { fps, durationSec: duration, quality, scale },
      webhookUrl: webhook_url,
    });
    if (!created) return withCors(NextResponse.json({ error: "Template not found" }, { status: 404 }));

    void processVideoJob(created.job.uid);

    return withCors(NextResponse.json({ uid: created.job.uid, status: "queued", template_id, format: "mp4", fps: created.job.fps, duration: created.job.durationSec, progress: 0, warnings: created.warnings.length ? created.warnings : undefined, created_at: created.job.createdAt }, { status: 202 }));
  } catch (error: any) {
    console.error("Video render API error:", error);
    return withCors(NextResponse.json({ error: error?.message || "Internal server error" }, { status: /does not contain video/i.test(error?.message || "") ? 400 : 500 }));
  }
}
