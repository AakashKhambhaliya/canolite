/**
 * Auto-cleanup for rendered images.
 *
 * Deletes render job rows and their corresponding image files from disk
 * after a configurable retention period. Keeps the storage lean.
 */
import { db } from "@/db";
import { renderJobs, projects } from "@/db/schema";
import { lt, and, isNotNull, eq, inArray } from "drizzle-orm";
import { deleteFile } from "@/lib/storage";

const DEFAULT_RETENTION_HOURS = 24;

/** Rows eligible for cleanup: completed, and older than the retention cutoff. */
function cleanableWhere(retentionHours: number, projectId?: string) {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
  return projectId
    ? and(
        lt(renderJobs.createdAt, cutoff),
        isNotNull(renderJobs.completedAt),
        eq(renderJobs.projectId, projectId)
      )
    : and(lt(renderJobs.createdAt, cutoff), isNotNull(renderJobs.completedAt));
}

/**
 * How many renders cleanup WOULD remove right now. Read-only — this backs the
 * GET side of /api/cleanup, which must not change state (see the route).
 */
export async function countCleanableRenders(
  retentionHours: number = DEFAULT_RETENTION_HOURS,
  projectId?: string
): Promise<number> {
  const rows = await db
    .select({ id: renderJobs.id })
    .from(renderJobs)
    .where(cleanableWhere(retentionHours, projectId));
  return rows.length;
}

/**
 * Delete completed/failed renders older than `retentionHours` for a project.
 * If `projectId` is omitted, applies across all projects (used internally).
 */
export async function cleanupOldRenders(
  retentionHours: number = DEFAULT_RETENTION_HOURS,
  projectId?: string
): Promise<{ deleted: number; errors: number }> {
  const where = cleanableWhere(retentionHours, projectId);

  // Find the matching jobs (so we can remove their files first). Video jobs
  // write a poster alongside the MP4 and record it in its own column, so
  // sweeping only imageUrl left one orphaned JPEG per video render on disk
  // forever — exactly what retention exists to prevent. The manual per-render
  // delete already removes all three; match it here.
  const oldJobs = await db
    .select({
      id: renderJobs.id,
      imageUrl: renderJobs.imageUrl,
      outputUrl: renderJobs.outputUrl,
      posterUrl: renderJobs.posterUrl,
    })
    .from(renderJobs)
    .where(where);

  if (oldJobs.length === 0) {
    return { deleted: 0, errors: 0 };
  }

  let errors = 0;
  for (const job of oldJobs) {
    // De-duplicated: image jobs store the same URL in imageUrl and outputUrl,
    // and deleting the same key twice would count a phantom error.
    const urls = new Set(
      [job.imageUrl, job.outputUrl, job.posterUrl].filter(Boolean) as string[]
    );
    for (const url of urls) {
      try {
        // A stored URL looks like ${APP_URL}/storage/renders/img_xxx.png
        const match = url.match(/\/storage\/(.+)$/);
        if (match) await deleteFile(match[1]);
      } catch {
        errors++;
      }
    }
  }

  // Delete by the exact IDs just processed, not by re-running the
  // time-based `where` — a job that matched createdAt < cutoff but was
  // still incomplete (excluded above by isNotNull(completedAt)) can finish
  // during the file-deletion loop above and start matching `where` by now,
  // which would delete its DB row here without ever having deleted its
  // file above, orphaning it on disk permanently.
  await db.delete(renderJobs).where(
    inArray(
      renderJobs.id,
      oldJobs.map((j) => j.id)
    )
  );

  const deleted = oldJobs.length;
  console.log(
    `[cleanup] Deleted ${deleted} renders older than ${retentionHours}h` +
      (projectId ? ` (project ${projectId})` : "") +
      ` (${errors} file errors)`
  );

  return { deleted, errors };
}

/**
 * Scheduled cleanup: honor each project's own `retentionHours` setting.
 */
export async function cleanupScheduled(): Promise<{
  deleted: number;
  errors: number;
}> {
  const rows = await db
    .select({ id: projects.id, retentionHours: projects.retentionHours })
    .from(projects);

  let deleted = 0;
  let errors = 0;
  for (const p of rows) {
    const r = await cleanupOldRenders(
      p.retentionHours ?? DEFAULT_RETENTION_HOURS,
      p.id
    );
    deleted += r.deleted;
    errors += r.errors;
  }
  return { deleted, errors };
}
