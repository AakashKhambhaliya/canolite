import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, renderJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateId } from "@/lib/utils";
import { applyModifications } from "@/lib/render/apply-modifications";
import { processRenderJob } from "@/lib/render/process-job";

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

    // Find template
    const [template] = await db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.templateId, template_id),
          eq(templates.projectId, user.projectId),
          eq(templates.isDeleted, false)
        )
      )
      .limit(1);

    if (!template) {
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 }
      );
    }

    // Resolve output settings (API params → template defaults → system defaults)
    const outputDefaults = (template.outputDefaults as any) || {};
    const resolvedFormat = format || outputDefaults.format || "png";
    const resolvedQuality = quality || outputDefaults.quality || 90;
    const resolvedScale = Math.min(scale || outputDefaults.scale || 1, 3);

    // Validate modifications
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
        projectId: user.projectId,
        status: "queued",
        modifications: modifications || [],
        format: resolvedFormat,
        quality: resolvedQuality,
        scale: resolvedScale,
      })
      .returning();

    // Render synchronously so the dashboard gets the image back immediately.
    await processRenderJob(job.uid);

    const [finished] = await db
      .select()
      .from(renderJobs)
      .where(eq(renderJobs.id, job.id))
      .limit(1);

    return NextResponse.json({
      uid: job.uid,
      status: finished?.status || "done",
      template_id: template.templateId,
      format: resolvedFormat,
      quality: resolvedQuality,
      scale: resolvedScale,
      image_url: finished?.imageUrl,
      error: finished?.errorMessage || undefined,
      warnings,
      created_at: job.createdAt,
    });
  } catch (error) {
    console.error("Error creating render:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
