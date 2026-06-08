import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, renderJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-auth";
import { generateId } from "@/lib/utils";
import { processBatch } from "@/lib/render/process-job";
import { withCors, handleOptions } from "@/lib/cors";
import { batchRequestSchema } from "@/lib/validation";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    const rawBody = await request.json();

    // Validate input
    const parsed = batchRequestSchema.safeParse(rawBody);
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

    // Find template
    const [template] = await db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.templateId, template_id),
          eq(templates.projectId, auth.projectId),
          eq(templates.isDeleted, false)
        )
      )
      .limit(1);

    if (!template) {
      return withCors(
        NextResponse.json({ error: "Template not found" }, { status: 404 })
      );
    }

    const outputDefaults = (template.outputDefaults as any) || {};
    const resolvedFormat = format || outputDefaults.format || "png";
    const resolvedQuality = quality || outputDefaults.quality || 90;
    const resolvedScale = Math.min(scale || outputDefaults.scale || 1, 3);

    const batchUid = generateId("batch");
    const uids: string[] = [];

    const jobValues = items.map((item) => {
      const uid = generateId("img");
      uids.push(uid);
      return {
        uid,
        batchUid,
        templateId: template.id,
        projectId: auth.projectId,
        status: "queued" as const,
        modifications: item.modifications || [],
        format: resolvedFormat,
        quality: resolvedQuality,
        scale: resolvedScale,
        webhookUrl: item.webhook_url || null,
      };
    });

    await db.insert(renderJobs).values(jobValues);

    // Process the batch in the background; clients poll each uid.
    void processBatch(uids);

    return withCors(
      NextResponse.json(
        {
          batch_uid: batchUid,
          uids,
          count: items.length,
          status: "queued",
          template_id: template.templateId,
          format: resolvedFormat,
          quality: resolvedQuality,
          scale: resolvedScale,
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
