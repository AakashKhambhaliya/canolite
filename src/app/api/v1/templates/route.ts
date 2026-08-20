import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";

export async function OPTIONS() {
  return handleOptions();
}

export async function GET(request: Request) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    const result = await db
      .select({
        template_id: templates.templateId,
        name: templates.name,
        description: templates.description,
        width: templates.width,
        height: templates.height,
        output_defaults: templates.outputDefaults,
        has_video: templates.hasVideo,
        video_defaults: templates.videoDefaults,
        created_at: templates.createdAt,
        updated_at: templates.updatedAt,
      })
      .from(templates)
      .where(
        and(
          eq(templates.projectId, auth.projectId),
          eq(templates.isDeleted, false)
        )
      )
      .orderBy(desc(templates.updatedAt));

    return withCors(NextResponse.json({ templates: result }));
  } catch (error) {
    console.error("Error listing templates:", error);
    return withCors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 })
    );
  }
}
