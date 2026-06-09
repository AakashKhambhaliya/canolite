import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";
import { renderRequestSchema } from "@/lib/validation";
import { createRenderJob } from "@/lib/render/create-job";
import { processRenderJob } from "@/lib/render/process-job";
import { absoluteForRequest } from "@/lib/storage";
import { isUrlSafe } from "@/lib/ssrf";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    const parsed = renderRequestSchema.safeParse(await request.json());
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

    const {
      template_id,
      modifications,
      format,
      quality,
      scale,
      webhook_url,
      synchronous,
    } = parsed.data;

    // SSRF guard: reject per-request webhooks that target non-public hosts.
    if (webhook_url && !(await isUrlSafe(webhook_url))) {
      return withCors(
        NextResponse.json(
          { error: "webhook_url must be a public http(s) URL" },
          { status: 400 }
        )
      );
    }

    const created = await createRenderJob({
      projectId: auth.projectId,
      templateId: template_id,
      modifications,
      output: { format, quality, scale },
      webhookUrl: webhook_url,
    });
    if (!created) {
      return withCors(
        NextResponse.json({ error: "Template not found" }, { status: 404 })
      );
    }

    // Synchronous mode: wait for the render and return the image_url directly,
    // so callers don't have to poll GET /v1/images/:uid.
    if (synchronous) {
      await processRenderJob(created.job.uid);

      const [job] = await db
        .select()
        .from(renderJobs)
        .where(eq(renderJobs.uid, created.job.uid))
        .limit(1);

      if (job?.status === "failed") {
        return withCors(
          NextResponse.json(
            {
              uid: created.job.uid,
              status: "failed",
              template_id,
              error: job.errorMessage || "Render failed",
              warnings: created.warnings.length ? created.warnings : undefined,
            },
            { status: 422 }
          )
        );
      }

      return withCors(
        NextResponse.json(
          {
            uid: created.job.uid,
            status: job?.status || "done",
            template_id,
            image_url: absoluteForRequest(request, job?.imageUrl),
            format: created.resolved.format,
            quality: created.resolved.quality,
            scale: created.resolved.scale,
            duration_ms: job?.durationMs ?? undefined,
            warnings: created.warnings.length ? created.warnings : undefined,
            created_at: created.job.createdAt,
            completed_at: job?.completedAt ?? undefined,
          },
          { status: 200 }
        )
      );
    }

    // Async (default): process in the background; clients poll GET /v1/images/:uid.
    void processRenderJob(created.job.uid);

    return withCors(
      NextResponse.json(
        {
          uid: created.job.uid,
          status: "queued",
          template_id,
          format: created.resolved.format,
          quality: created.resolved.quality,
          scale: created.resolved.scale,
          warnings: created.warnings.length ? created.warnings : undefined,
          created_at: created.job.createdAt,
        },
        { status: 202 }
      )
    );
  } catch (error) {
    console.error("API render error:", error);
    return withCors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 })
    );
  }
}
