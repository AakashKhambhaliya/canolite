import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, templateFields } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateId } from "@/lib/utils";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const result = await db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.projectId, user.projectId),
          eq(templates.isDeleted, false)
        )
      )
      .orderBy(desc(templates.updatedAt));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching templates:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { name, width, height } = body;

    const templateId = generateId("tmpl");

    // Default empty Fabric canvas
    const defaultDesignJson = {
      version: "5.3.0",
      objects: [],
      background: "#ffffff",
    };

    const [template] = await db
      .insert(templates)
      .values({
        templateId,
        projectId: user.projectId,
        name: name || "Untitled Template",
        width: width || 1080,
        height: height || 1350,
        designJson: defaultDesignJson,
        outputDefaults: { format: "png", quality: 90, scale: 1 },
      })
      .returning();

    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    console.error("Error creating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
