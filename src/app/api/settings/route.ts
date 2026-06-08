import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, user.projectId))
      .limit(1);

    return NextResponse.json({
      ...project,
      defaultFormat: project?.defaultFormat || "png",
      defaultQuality: project?.defaultQuality ?? 90,
      defaultScale: project?.defaultScale ?? 1,
      retentionHours: project?.retentionHours ?? 24,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const {
      webhookUrl,
      webhookSecret,
      defaultFormat,
      defaultQuality,
      defaultScale,
      retentionHours,
    } = body;

    const updateData: Record<string, any> = {
      webhookUrl: webhookUrl || null,
      webhookSecret: webhookSecret || null,
      updatedAt: new Date(),
    };

    if (defaultFormat !== undefined) updateData.defaultFormat = defaultFormat;
    if (defaultQuality !== undefined) updateData.defaultQuality = Number(defaultQuality);
    if (defaultScale !== undefined) updateData.defaultScale = Number(defaultScale);
    if (retentionHours !== undefined) updateData.retentionHours = Number(retentionHours);

    await db
      .update(projects)
      .set(updateData)
      .where(eq(projects.id, user.projectId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
