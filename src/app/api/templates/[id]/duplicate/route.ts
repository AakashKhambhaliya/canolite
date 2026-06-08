import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateId } from "@/lib/utils";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const [original] = await db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.id, params.id),
          eq(templates.projectId, user.projectId),
          eq(templates.isDeleted, false)
        )
      )
      .limit(1);

    if (!original) {
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 }
      );
    }

    const [duplicate] = await db
      .insert(templates)
      .values({
        templateId: generateId("tmpl"),
        projectId: user.projectId,
        name: `${original.name} (Copy)`,
        width: original.width,
        height: original.height,
        designJson: original.designJson,
        outputDefaults: original.outputDefaults,
        tags: original.tags,
      })
      .returning();

    return NextResponse.json(duplicate, { status: 201 });
  } catch (error) {
    console.error("Error duplicating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
