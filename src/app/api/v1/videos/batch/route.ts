import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";
import { z } from "zod";
import { modificationSchema } from "@/lib/validation";
import { createVideoBatchJobs } from "@/lib/render/create-job";
import { processVideoBatch } from "@/lib/render/process-video-job";
import { isUrlSafe } from "@/lib/ssrf";

const schema = z.object({
  template_id: z.string().min(1),
  items: z.array(z.object({ modifications: z.array(modificationSchema).optional().default([]), webhook_url: z.string().url().optional() })).min(1).max(20),
  fps: z.number().min(1).max(60).optional(),
  duration: z.number().min(0.1).max(120).optional(),
  quality: z.enum(["high", "balanced", "small"]).optional(),
});

export async function OPTIONS() { return handleOptions(); }

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return withCors(NextResponse.json({ error: "Validation error", details: parsed.error.issues }, { status: 400 }));
    const { template_id, items, fps, duration, quality } = parsed.data;
    for (const item of items) {
      if (item.webhook_url && !(await isUrlSafe(item.webhook_url))) return withCors(NextResponse.json({ error: "webhook_url must be a public http(s) URL" }, { status: 400 }));
    }
    const created = await createVideoBatchJobs({ projectId: auth.projectId, templateId: template_id, items, output: { fps, durationSec: duration, quality } });
    if (!created) return withCors(NextResponse.json({ error: "Template not found" }, { status: 404 }));
    void processVideoBatch(created.uids);
    return withCors(NextResponse.json({ batch_uid: created.batchUid, uids: created.uids, count: created.uids.length, status: "queued", template_id, format: "mp4" }, { status: 202 }));
  } catch (error: any) {
    console.error("Video batch API error:", error);
    return withCors(NextResponse.json({ error: error?.message || "Internal server error" }, { status: /does not contain video/i.test(error?.message || "") ? 400 : 500 }));
  }
}
