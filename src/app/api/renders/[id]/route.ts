import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { deleteFile } from "@/lib/storage";

/**
 * Delete a render job (and its stored image) for the current project.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const [job] = await db
      .select()
      .from(renderJobs)
      .where(
        and(
          eq(renderJobs.id, id),
          eq(renderJobs.projectId, user.projectId)
        )
      )
      .limit(1);

    if (!job) {
      return NextResponse.json(
        { error: "Render not found" },
        { status: 404 }
      );
    }

    // Remove stored output files (best-effort).
    for (const url of [job.imageUrl, job.outputUrl, job.posterUrl]) {
      if (url) {
        const marker = "/storage/";
        const idx = url.indexOf(marker);
        if (idx !== -1) {
          await deleteFile(url.slice(idx + marker.length));
        }
      }
    }

    await db.delete(renderJobs).where(eq(renderJobs.id, job.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting render:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
