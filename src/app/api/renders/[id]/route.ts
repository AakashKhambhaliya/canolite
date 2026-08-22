import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq, and, or } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { deleteFile } from "@/lib/storage";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Look up one render job in the current project by either identifier.
 *
 * Callers hold different ones: the dashboard lists carry the row `id`, while
 * POST /api/render hands back the public `uid` (`img_…` / `vid_…`). Accepting
 * both saves the caller a lookup, and they can't collide — `id` is a UUID and
 * `uid` is prefixed.
 *
 * The `id` comparison is only included when the key actually IS a UUID.
 * `id` is a uuid column, so PostgreSQL coerces the bound parameter to uuid to
 * evaluate the comparison — and it does that for the whole predicate before
 * any OR short-circuiting, so `id = 'vid_1c97…'` aborts the entire query with
 * `invalid input syntax for type uuid` rather than simply not matching. That
 * made every poll for a video render's progress fail with a 500.
 */
async function findJob(projectId: string, key: string) {
  const match = UUID_RE.test(key)
    ? or(eq(renderJobs.uid, key), eq(renderJobs.id, key))
    : eq(renderJobs.uid, key);

  const [job] = await db
    .select()
    .from(renderJobs)
    .where(and(eq(renderJobs.projectId, projectId), match))
    .limit(1);
  return job ?? null;
}

/**
 * Status of a single render job.
 *
 * Video renders are asynchronous — POST /api/render returns 202 with a uid the
 * moment the job is queued — so the dashboard needs somewhere to poll for
 * progress and the finished file. Without this, the Playground had no way to
 * follow an MP4 job at all.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    if (!id || id.length > 100) {
      return NextResponse.json({ error: "Invalid render id" }, { status: 400 });
    }

    const job = await findJob(user.projectId, id);
    if (!job) {
      return NextResponse.json({ error: "Render not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: job.id,
      uid: job.uid,
      status: job.status,
      progress: job.progress ?? 0,
      outputKind: job.outputKind,
      mimeType: job.mimeType,
      imageUrl: job.imageUrl,
      outputUrl: job.outputUrl,
      posterUrl: job.posterUrl,
      format: job.format,
      durationSec: job.durationSec,
      fps: job.fps,
      frameCount: job.frameCount,
      durationMs: job.durationMs,
      error: job.errorMessage || undefined,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
  } catch (error) {
    console.error("Error fetching render:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

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

    const job = await findJob(user.projectId, id);
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
