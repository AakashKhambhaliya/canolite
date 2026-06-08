import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";
import { batchRequestSchema } from "@/lib/validation";
import { createBatchJobs } from "@/lib/render/create-job";
import { processBatch } from "@/lib/render/process-job";
import { isUrlSafe } from "@/lib/ssrf";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    const parsed = batchRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return withCors(
        NextResponse.json(
          {
            error: "Validation error",
            details: parsed.error.issues.map((i) => ({
              field: i.path.join("."),
              message: i.message,
            })),
          },
          { status: 400 }
        )
      );
    }

    const { template_id, items, format, quality, scale } = parsed.data;

    // SSRF guard for per-item webhooks.
    for (const item of items) {
      if (item.webhook_url && !(await isUrlSafe(item.webhook_url))) {
        return withCors(
          NextResponse.json(
            { error: "webhook_url must be a public http(s) URL" },
            { status: 400 }
          )
        );
      }
    }

    const created = await createBatchJobs({
      projectId: auth.projectId,
      templateId: template_id,
      items,
      output: { format, quality, scale },
    });
    if (!created) {
      return withCors(
        NextResponse.json({ error: "Template not found" }, { status: 404 })
      );
    }

    void processBatch(created.uids);

    return withCors(
      NextResponse.json(
        {
          batch_uid: created.batchUid,
          uids: created.uids,
          count: created.uids.length,
          status: "queued",
          template_id,
          format: created.resolved.format,
          quality: created.resolved.quality,
          scale: created.resolved.scale,
        },
        { status: 202 }
      )
    );
  } catch (error) {
    console.error("Batch render error:", error);
    return withCors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 })
    );
  }
}
