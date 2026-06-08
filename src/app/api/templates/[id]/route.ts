import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, templateFields } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { extractFields } from "@/lib/render/apply-modifications";

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

    const body = await request.json();
    const { name, width, height, designJson, outputDefaults } = body;

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (width !== undefined) updateData.width = width;
    if (height !== undefined) updateData.height = height;
    if (designJson !== undefined) updateData.designJson = designJson;
    if (outputDefaults !== undefined) updateData.outputDefaults = outputDefaults;

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

    await db
      .update(templates)
      .set({ isDeleted: true, updatedAt: new Date() })
      .where(
        and(
          eq(templates.id, id),
          eq(templates.projectId, user.projectId)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
