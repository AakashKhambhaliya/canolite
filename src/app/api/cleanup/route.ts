import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { cleanupOldRenders, countCleanableRenders } from "@/lib/render/cleanup";
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
    const pending = await countCleanableRenders(retentionHours, user.projectId);

    return NextResponse.json({
      success: true,
      pending,
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

export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const retentionHours = await retentionFor(user.projectId);
    const result = await cleanupOldRenders(retentionHours, user.projectId);

    return NextResponse.json({
      success: true,
      ...result,
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
