import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, templateFields } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-auth";
import { withCors, handleOptions } from "@/lib/cors";

export async function OPTIONS() {
  return handleOptions();
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authenticateApiKey(request);
    if (auth instanceof NextResponse) return withCors(auth);

    if (!params.id || params.id.length < 4) {
      return withCors(
        NextResponse.json(
          { error: "Invalid template ID" },
          { status: 400 }
        )
      );
    }

    // Support lookup by templateId (e.g. tmpl_abc123)
    const [template] = await db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.templateId, params.id),
          eq(templates.projectId, auth.projectId),
          eq(templates.isDeleted, false)
        )
      )
      .limit(1);

    if (!template) {
      return withCors(
        NextResponse.json(
          { error: "Template not found" },
          { status: 404 }
        )
      );
    }

    // Get fields
    const fields = await db
      .select({
        name: templateFields.name,
        type: templateFields.type,
        default_value: templateFields.defaultValue,
        properties: templateFields.properties,
      })
      .from(templateFields)
      .where(eq(templateFields.templateId, template.id));

    return withCors(
      NextResponse.json({
        template_id: template.templateId,
        name: template.name,
        description: template.description,
        width: template.width,
        height: template.height,
        output_defaults: template.outputDefaults,
        fields,
        created_at: template.createdAt,
        updated_at: template.updatedAt,
      })
    );
  } catch (error) {
    console.error("Error fetching template:", error);
    return withCors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 })
    );
  }
}
