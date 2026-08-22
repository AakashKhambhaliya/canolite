import { NextResponse } from "next/server";
import { db } from "@/db";
import { templates, templateFields } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateId } from "@/lib/utils";
import { generateThumbnail } from "@/lib/render/thumbnail";
import { templateCreateSchema } from "@/lib/validation";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // The listing UI only needs metadata and the thumbnail — never the
    // design itself. designJson is a Fabric canvas that embeds images as
    // base64 data URIs, so a bare select() ships megabytes per template and
    // is refetched on every mutation. Project away that one heavy jsonb
    // column; every other field is kept so consumers' shape is unchanged.
    const result = await db
      .select({
        id: templates.id,
        templateId: templates.templateId,
        projectId: templates.projectId,
        name: templates.name,
        description: templates.description,
        width: templates.width,
        height: templates.height,
        outputDefaults: templates.outputDefaults,
        thumbnailUrl: templates.thumbnailUrl,
        tags: templates.tags,
        isDeleted: templates.isDeleted,
        version: templates.version,
        createdAt: templates.createdAt,
        updatedAt: templates.updatedAt,
      })
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

    // Validated, not destructured raw: width/height are a direct multiplier on
    // render-time memory, so an out-of-range value here is a stored DoS on
    // every later render of the template (see validation.ts).
    const parsed = templateCreateSchema.safeParse(await request.json());
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
    const { name, width, height } = parsed.data;

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

    // Fire-and-forget: a render takes seconds and must not delay the response.
    // On failure the column stays NULL and the next boot sweep retries.
    void generateThumbnail(template.id);

    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    console.error("Error creating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
