import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, templateFields } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { extractFields } from "@/lib/render/apply-modifications";
import { generateThumbnail } from "@/lib/render/thumbnail";
import { deleteFile } from "@/lib/storage";
import { isImage } from "@/lib/design/predicates";
import { templateUpdateSchema } from "@/lib/validation";

function designHasVideo(value: any): boolean {
  const objects = Array.isArray(value?.objects) ? value.objects : [];
  const visit = (obj: any): boolean => {
    if (!obj || typeof obj !== "object") return false;
    // Must be case-insensitive (isImage lowercases): a LIVE Fabric object
    // reports type "image", but the SERIALIZED design stored here reports
    // "Image". Comparing to "image" directly never matched, so has_video
    // stayed false for every template — which is what hid MP4 from the export
    // options and made video renders fail with "does not contain video layers".
    if (isImage(obj) && obj.mediaType === "video") return true;
    return Array.isArray(obj.objects) && obj.objects.some(visit);
  };
  return objects.some(visit);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const [template] = await db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.id, id),
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

    // Also get fields
    const fields = await db
      .select()
      .from(templateFields)
      .where(eq(templateFields.templateId, template.id));

    return NextResponse.json({ ...template, fields });
  } catch (error) {
    console.error("Error fetching template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Same reasoning as the create route: an unbounded width/height persisted
    // here becomes an out-of-memory failure in every later render.
    const parsed = templateUpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json(
        {
          error: issue
            ? `${issue.path.join(".") || "body"}: ${issue.message}`
            : "Invalid template",
        },
        { status: 400 }
      );
    }
    const { name, width, height, designJson, outputDefaults, videoDefaults } =
      parsed.data;

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (width !== undefined) updateData.width = width;
    if (height !== undefined) updateData.height = height;
    if (designJson !== undefined) {
      updateData.designJson = designJson;
      updateData.hasVideo = designHasVideo(designJson);
    }
    if (outputDefaults !== undefined) updateData.outputDefaults = outputDefaults;
    if (videoDefaults !== undefined) updateData.videoDefaults = videoDefaults;

    const designChanged =
      designJson !== undefined || width !== undefined || height !== undefined;

    // A stale preview must not outlive the design it depicts. Null the column
    // now; the regeneration below repoints it at the new file. generateThumbnail
    // owns cleanup of the superseded file once the new one is written.
    if (designChanged) updateData.thumbnailUrl = null;

    const [template] = await db
      .update(templates)
      .set(updateData)
      .where(
        and(
          eq(templates.id, id),
          eq(templates.projectId, user.projectId),
          eq(templates.isDeleted, false)
        )
      )
      .returning();

    if (!template) {
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 }
      );
    }

    if (designChanged) {
      // Fire-and-forget: a render takes seconds and must not delay the
      // response. generateThumbnail deletes the superseded file itself once
      // the new one is written.
      void generateThumbnail(template.id);
    }

    // Regenerate template_fields from design_json
    if (designJson) {
      // Delete existing fields
      await db
        .delete(templateFields)
        .where(eq(templateFields.templateId, template.id));

      // Extract and insert new fields
      const fields = extractFields(designJson);
      if (fields.length > 0) {
        await db.insert(templateFields).values(
          fields.map((f, idx) => ({
            templateId: template.id,
            name: f.name,
            type: f.type,
            defaultValue: f.defaultValue,
            properties: f.properties,
            sortOrder: idx,
          }))
        );
      }
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("Error updating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const [existing] = await db
      .select({ thumbnailUrl: templates.thumbnailUrl })
      .from(templates)
      .where(
        and(
          eq(templates.id, id),
          eq(templates.projectId, user.projectId)
        )
      )
      .limit(1);

    await db
      .update(templates)
      .set({ isDeleted: true, updatedAt: new Date(), thumbnailUrl: null })
      .where(
        and(
          eq(templates.id, id),
          eq(templates.projectId, user.projectId)
        )
      );

    // A soft-deleted template's thumbnail file is orphaned. Remove it —
    // best-effort, deleteFile ignores misses.
    const previous = existing?.thumbnailUrl;
    if (previous?.startsWith("/storage/")) {
      void deleteFile(previous.replace(/^\/storage\//, ""));
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
