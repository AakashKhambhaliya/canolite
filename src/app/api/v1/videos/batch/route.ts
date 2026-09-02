import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";
import { z } from "zod";
import { modificationSchema } from "@/lib/validation";
import {
  MAX_DURATION_SEC,
  MAX_FPS,
  MAX_SCALE,
  MIN_DURATION_SEC,
  MIN_FPS,
  MIN_SCALE,
  VIDEO_QUALITY_PRESETS,
} from "@/lib/output-settings";
import { createVideoBatchJobs } from "@/lib/render/create-job";
import { processVideoBatch } from "@/lib/render/process-video-job";
import { isUrlSafe } from "@/lib/ssrf";

const schema = z.object({
  template_id: z.string().min(1),
  items: z.array(z.object({ modifications: z.array(modificationSchema).optional().default([]), webhook_url: z.string().url().optional() })).min(1).max(20),
  fps: z.number().min(MIN_FPS).max(MAX_FPS).optional(),
  duration: z.number().min(MIN_DURATION_SEC).max(MAX_DURATION_SEC).optional(),
  quality: z.enum(VIDEO_QUALITY_PRESETS).optional(),
  scale: z.number().min(MIN_SCALE).max(MAX_SCALE).optional(),
});

export async function OPTIONS() { return handleOptions(); }

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return withCors(NextResponse.json({ error: "Validation error", details: parsed.error.issues }, { status: 400 }));
    const { template_id, items, fps, duration, quality, scale } = parsed.data;
    for (const item of items) {
      if (item.webhook_url && !(await isUrlSafe(item.webhook_url))) return withCors(NextResponse.json({ error: "webhook_url must be a public http(s) URL" }, { status: 400 }));
    }
    const created = await createVideoBatchJobs({ projectId: auth.projectId, templateId: template_id, items, output: { fps, durationSec: duration, quality, scale } });
    if (!created) return withCors(NextResponse.json({ error: "Template not found" }, { status: 404 }));
    void processVideoBatch(created.uids);
    return withCors(NextResponse.json({ batch_uid: created.batchUid, uids: created.uids, count: created.uids.length, status: "queued", template_id, format: "mp4" }, { status: 202 }));
  } catch (error: any) {
    console.error("Video batch API error:", error);
    return withCors(NextResponse.json({ error: error?.message || "Internal server error" }, { status: /does not contain video/i.test(error?.message || "") ? 400 : 500 }));
  }
}
