import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, templateFields } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { templateUpdateSchema } from "@/lib/validation";
import { designHasVideo, documentFields } from "@/lib/editor/design-fields";
import { generateId } from "@/lib/utils";
import { generateThumbnail } from "@/lib/render/thumbnail";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const [original] = await db
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

    if (!original) {
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 },
      );
    }

    // A normal dashboard duplicate has no body. After an editor conflict a
    // caller can instead copy its unsaved draft. Neither path writes to the
    // original row; the copy and its derived field index commit together.
    const parsed = templateUpdateSchema.safeParse(
      await request
        .text()
        .then((text) => (text.trim() ? JSON.parse(text) : {}))
        .catch(() => null),
    );
    if (!parsed.success)
      return NextResponse.json(
        { error: "Invalid template copy." },
        { status: 400 },
      );
    const draft = parsed.data;
    const design =
      draft.designJson === undefined ? original.designJson : draft.designJson;
    let fields: ReturnType<typeof documentFields>;
    try {
      fields = documentFields(design);
    } catch {
      return NextResponse.json(
        {
          error: "Invalid design fields. Check the field names before copying.",
        },
        { status: 400 },
      );
    }
    const duplicate = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(templates)
        .values({
          templateId: generateId("tmpl"),
          projectId: user.projectId,
          name: `${(draft.name ?? original.name).slice(0, 193)} (Copy)`,
          description: original.description,
          width: draft.width ?? original.width,
          height: draft.height ?? original.height,
          designJson: design,
          hasVideo: designHasVideo(design),
          outputDefaults: (draft.outputDefaults ??
            original.outputDefaults) as typeof original.outputDefaults,
          videoDefaults: (draft.videoDefaults ??
            original.videoDefaults) as typeof original.videoDefaults,
          tags: original.tags,
        })
        .returning();
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
      return row;
    });

    // Fire-and-forget: a render takes seconds and must not delay the response.
    // On failure the column stays NULL and the next boot sweep retries.
    void generateThumbnail(duplicate.id);

    return NextResponse.json(duplicate, { status: 201 });
  } catch (error) {
    console.error("Error duplicating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
