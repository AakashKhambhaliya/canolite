import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, renderJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateId } from "@/lib/utils";
import { processBatch } from "@/lib/render/process-job";

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

    if (!items || !Array.isArray(items) || items.length === 0) {
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

    const outputDefaults = (template.outputDefaults as any) || {};
    const resolvedFormat = format || outputDefaults.format || "png";
    const resolvedQuality = quality || outputDefaults.quality || 90;
    const resolvedScale = Math.min(scale || outputDefaults.scale || 1, 3);

    const batchUid = generateId("batch");
    const uids: string[] = [];

    // Create all render jobs
    const jobValues = items.map((item: any) => {
      const uid = generateId("img");
      uids.push(uid);
      return {
        uid,
        batchUid,
        templateId: template.id,
        projectId: user.projectId,
        status: "queued" as const,
        modifications: item.modifications || [],
        format: resolvedFormat,
        quality: resolvedQuality,
        scale: resolvedScale,
      };
    });

    await db.insert(renderJobs).values(jobValues);

    // Process the batch in the background; the renders page polls for status.
    void processBatch(uids);

    return NextResponse.json({
      batch_uid: batchUid,
      uids,
      count: items.length,
      status: "queued",
      template_id: template.templateId,
      format: resolvedFormat,
      quality: resolvedQuality,
      scale: resolvedScale,
    });
  } catch (error) {
    console.error("Error creating batch:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
