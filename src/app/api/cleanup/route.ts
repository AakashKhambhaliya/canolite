import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { cleanupOldRenders } from "@/lib/render/cleanup";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/cleanup — run cleanup and return stats
 * POST /api/cleanup — run cleanup manually
 */

export async function GET() {
  return runCleanup();
}

export async function POST() {
  return runCleanup();
}

async function runCleanup() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Get retention setting from project
    const [project] = await db
      .select({ retentionHours: projects.retentionHours })
      .from(projects)
      .where(eq(projects.id, user.projectId))
      .limit(1);

    const retentionHours = project?.retentionHours ?? 24;
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
