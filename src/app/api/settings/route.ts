import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
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
      webhookUrl: project?.webhookUrl ?? null,
      hasWebhookSecret: Boolean(project?.webhookSecret),
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

    if (webhookUrl && !(await isUrlSafe(webhookUrl))) {
      return NextResponse.json({ error: "Webhook URL must be public HTTP(S)." }, { status: 400 });
    }
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (webhookUrl !== undefined) {
      updateData.webhookUrl = webhookUrl || null;
      // Changing a receiver never transfers its predecessor's signing key.
      updateData.webhookSecret = sql`case when ${projects.webhookUrl} = ${webhookUrl} then ${projects.webhookSecret} else null end`;
    }
    if (webhookSecret !== undefined) updateData.webhookSecret = webhookSecret || null;

    // "jpeg" is stored as "jpg" so every reader sees one spelling.
    if (defaultFormat !== undefined)
      updateData.defaultFormat = normalizeFormat(defaultFormat) ?? "png";
    if (defaultQuality !== undefined) updateData.defaultQuality = defaultQuality;
    if (defaultScale !== undefined) updateData.defaultScale = defaultScale;
    if (defaultFps !== undefined) updateData.defaultFps = defaultFps;
    if (defaultVideoQuality !== undefined)
      updateData.defaultVideoQuality = defaultVideoQuality;
    if (retentionHours !== undefined) updateData.retentionHours = retentionHours;

    const valid = await db.transaction(async (tx) => {
      const [current] = await tx.select({url: projects.webhookUrl}).from(projects).where(eq(projects.id, user.projectId)).for("update");
      if (!current || (webhookSecret && !(webhookUrl ?? current.url)?.startsWith("https://"))) return false;
      await tx.update(projects).set(updateData).where(eq(projects.id, user.projectId));
      return true;
    });
    if (!valid) return NextResponse.json({error: "Save an HTTPS webhook URL to set a signing secret."}, {status: 400});
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
