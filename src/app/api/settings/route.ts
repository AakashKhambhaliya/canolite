import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { settingsSchema } from "@/lib/validation";
import { isUrlSafe } from "@/lib/ssrf";
import {
  normalizeFormat,
  projectDefaultsLayer,
  resolveOutputSettings,
} from "@/lib/output-settings";

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

    // The output block is resolved through the shared helper so the values the
    // Settings form shows are literally the ones the renderer will use.
    const output = resolveOutputSettings(projectDefaultsLayer(project));

    return NextResponse.json({
      ...project,
      defaultFormat: output.format,
      defaultQuality: output.quality,
      defaultScale: output.scale,
      defaultFps: output.fps,
      defaultVideoQuality: output.videoQuality,
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

    const parsed = settingsSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid settings" },
        { status: 400 }
      );
    }
    const {
      webhookUrl,
      webhookSecret,
      defaultFormat,
      defaultQuality,
      defaultScale,
      defaultFps,
      defaultVideoQuality,
      retentionHours,
    } = parsed.data;

    // Every other webhook URL entry point (webhook-test, the v1 render APIs)
    // is checked against the SSRF guard before use — this one wasn't, even
    // though nothing currently reads projects.webhookUrl back out for
    // delivery. Guard it now so it can't become a live SSRF the moment it
    // does get wired into a delivery path.
    if (webhookUrl && !(await isUrlSafe(webhookUrl))) {
      return NextResponse.json(
        { error: "webhookUrl must be a public http(s) URL" },
        { status: 400 }
      );
    }

    const updateData: Record<string, any> = {
      webhookUrl: webhookUrl || null,
      webhookSecret: webhookSecret || null,
      updatedAt: new Date(),
    };

    // "jpeg" is stored as "jpg" so every reader sees one spelling.
    if (defaultFormat !== undefined)
      updateData.defaultFormat = normalizeFormat(defaultFormat) ?? "png";
    if (defaultQuality !== undefined) updateData.defaultQuality = defaultQuality;
    if (defaultScale !== undefined) updateData.defaultScale = defaultScale;
    if (defaultFps !== undefined) updateData.defaultFps = defaultFps;
    if (defaultVideoQuality !== undefined)
      updateData.defaultVideoQuality = defaultVideoQuality;
    if (retentionHours !== undefined) updateData.retentionHours = retentionHours;

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
