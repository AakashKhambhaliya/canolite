import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, renderJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-auth";
import { generateId } from "@/lib/utils";
import { applyModifications } from "@/lib/render/apply-modifications";
import { processRenderJob } from "@/lib/render/process-job";
import { withCors, handleOptions } from "@/lib/cors";
import { renderRequestSchema } from "@/lib/validation";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    const rawBody = await request.json();

    // Validate input
    const parsed = renderRequestSchema.safeParse(rawBody);
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

    const { template_id, modifications, format, quality, scale } = parsed.data;

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

    // Resolve output settings (API → template defaults → system defaults)
    const outputDefaults = (template.outputDefaults as any) || {};
    const resolvedFormat = format || outputDefaults.format || "png";
    const resolvedQuality = quality || outputDefaults.quality || 90;
    const resolvedScale = Math.min(scale || outputDefaults.scale || 1, 3);

    // Validate + apply modifications
    const { warnings } = applyModifications(
      template.designJson,
      modifications || []
    );

    // Create render job
    const uid = generateId("img");
    const [job] = await db
      .insert(renderJobs)
      .values({
        uid,
        templateId: template.id,
        projectId: auth.projectId,
        status: "queued",
        modifications: modifications || [],
        format: resolvedFormat,
        quality: resolvedQuality,
        scale: resolvedScale,
      })
      .returning();

    // Process the render in the background; clients poll GET /v1/images/:uid.
    void processRenderJob(job.uid);

    return withCors(
      NextResponse.json(
        {
          uid: job.uid,
          status: "queued",
          template_id: template.templateId,
          format: resolvedFormat,
          quality: resolvedQuality,
          scale: resolvedScale,
          warnings: warnings.length > 0 ? warnings : undefined,
          created_at: job.createdAt,
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
