import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, templateFields } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateThumbnail } from "@/lib/render/thumbnail";
import { deleteFile } from "@/lib/storage";
import { designHasVideo, documentFields } from "@/lib/editor/design-fields";
import { templateUpdateSchema } from "@/lib/validation";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
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
          eq(templates.isDeleted, false),
        ),
      )
      .limit(1);

    if (!template) {
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 },
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
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Same reasoning as the create route: an unbounded width/height persisted
    // here becomes an out-of-memory failure in every later render.
    const parsed = templateUpdateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json(
        {
          error: issue
            ? `${issue.path.join(".") || "body"}: ${issue.message}`
            : "Invalid template",
        },
        { status: 400 },
      );
    }
    const {
      name,
      width,
      height,
      designJson,
      outputDefaults,
      videoDefaults,
      expectedVersion,
    } = parsed.data;

    // Legacy clients can omit expectedVersion, but every write advances the
    // same counter. Existing NULL version rows represent the original v1.
    const currentVersion = sql<number>`coalesce(${templates.version}, 1)`;
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (width !== undefined) updateData.width = width;
    if (height !== undefined) updateData.height = height;
    if (designJson !== undefined) {
      updateData.designJson = designJson;
    }
    if (outputDefaults !== undefined)
      updateData.outputDefaults = outputDefaults;
    if (videoDefaults !== undefined) updateData.videoDefaults = videoDefaults;

    const designChanged =
      designJson !== undefined || width !== undefined || height !== undefined;

    // A stale preview must not outlive the design it depicts. Null the column
    // now; the regeneration below repoints it at the new file. generateThumbnail
    // owns cleanup of the superseded file once the new one is written.
    if (designChanged) updateData.thumbnailUrl = null;

    const scope = and(
      eq(templates.id, id),
      eq(templates.projectId, user.projectId),
      eq(templates.isDeleted, false),
    );
    let fields: ReturnType<typeof documentFields> | null;
    try {
      fields = designJson === undefined ? null : documentFields(designJson);
      if (fields !== null) updateData.hasVideo = designHasVideo(designJson);
    } catch {
      return NextResponse.json(
        {
          error:
            "Invalid design or field name. Field names must be 255 characters or fewer.",
        },
        { status: 400 },
      );
    }
    // Commit the document and its derived API fields together. Two tabs
    // racing the same version cannot both pass PostgreSQL's row predicate.
    const template = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(templates)
        .set({ ...updateData, version: sql`${currentVersion} + 1` })
        .where(
          and(
            scope,
            expectedVersion === undefined
              ? undefined
              : eq(currentVersion, expectedVersion),
          ),
        )
        .returning();
      if (!row) return null;
      if (fields !== null) {
        await tx
          .delete(templateFields)
          .where(eq(templateFields.templateId, row.id));
        if (fields.length)
          await tx
            .insert(templateFields)
            .values(
              fields.map((f, sortOrder) => ({
                ...f,
                sortOrder,
                templateId: row.id,
              })),
            );
      }
      return row;
    });
    if (!template) {
      if (expectedVersion !== undefined) {
        const [existing] = await db
          .select({ id: templates.id })
          .from(templates)
          .where(scope)
          .limit(1);
        if (existing)
          return NextResponse.json(
            {
              error:
                "A newer version was saved elsewhere. Your edits have not been overwritten.",
            },
            { status: 409 },
          );
      }
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 },
      );
    }
    if (designChanged) void generateThumbnail(template.id);

    return NextResponse.json(template);
  } catch (error) {
    console.error("Error updating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
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
      .where(and(eq(templates.id, id), eq(templates.projectId, user.projectId)))
      .limit(1);

    await db
      .update(templates)
      .set({ isDeleted: true, updatedAt: new Date(), thumbnailUrl: null })
      .where(
        and(eq(templates.id, id), eq(templates.projectId, user.projectId)),
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
      { status: 500 },
    );
  }
}
