import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  cleanupOldRenders,
  countCleanableRenders,
  countRenders,
  purgeAllRenders,
} from "@/lib/render/cleanup";
import { cleanupRequestSchema } from "@/lib/validation";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET  /api/cleanup — report how many renders are past retention (read-only)
 * POST /api/cleanup — actually delete them
 *
 * GET used to run the deletion too, which made it CSRF-able: the session
 * cookie is SameSite=Lax, and Lax deliberately still attaches the cookie to
 * top-level GET navigations — so any page that got the operator to follow a
 * link (or that opened one) could wipe their render history. A GET must not
 * change state; the destructive path lives on POST, where Lax withholds the
 * cookie from cross-site requests.
 *
 * POST takes an optional body:
 *   { scope: "retention" | "all", retentionHours?: number }
 * "retention" (the default) is the same sweep the hourly job runs. "all" is the
 * explicit manual purge — it exists because the retention sweep legitimately
 * deletes nothing when every render is newer than the cutoff, which read as a
 * broken button. `retentionHours` lets the Settings form apply the period it is
 * currently showing without making the operator save first.
 */

async function retentionFor(projectId: string): Promise<number> {
  const [project] = await db
    .select({ retentionHours: projects.retentionHours })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project?.retentionHours ?? 24;
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const retentionHours = await retentionFor(user.projectId);
    const [pending, total] = await Promise.all([
      countCleanableRenders(retentionHours, user.projectId),
      countRenders(user.projectId),
    ]);

    return NextResponse.json({
      success: true,
      pending,
      total,
      retention_hours: retentionHours,
    });
  } catch (error) {
    console.error("Cleanup status error:", error);
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

    // A body is optional — an empty POST still means "sweep by retention",
    // which is what the previous version of this route did.
    const raw = await request.json().catch(() => ({}));
    const parsed = cleanupRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid request" },
        { status: 400 }
      );
    }
    const { scope, retentionHours: requested } = parsed.data;

    if (scope === "all") {
      const result = await purgeAllRenders(user.projectId);
      return NextResponse.json({ success: true, scope, ...result });
    }

    const retentionHours = requested ?? (await retentionFor(user.projectId));
    const result = await cleanupOldRenders(retentionHours, user.projectId);
    const remaining = await countRenders(user.projectId);

    return NextResponse.json({
      success: true,
      scope,
      ...result,
      remaining,
      retention_hours: retentionHours,
    });
  } catch (error) {
    console.error("Cleanup error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
