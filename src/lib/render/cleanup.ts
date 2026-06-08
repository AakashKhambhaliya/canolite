/**
 * Auto-cleanup for rendered images.
 *
 * Deletes render job rows and their corresponding image files from disk
 * after a configurable retention period. Keeps the storage lean.
 */
import { db } from "@/db";
import { renderJobs, projects } from "@/db/schema";
import { lt, and, isNotNull, eq } from "drizzle-orm";
import { deleteFile } from "@/lib/storage";

const DEFAULT_RETENTION_HOURS = 24;

/**
 * Delete completed/failed renders older than `retentionHours` for a project.
 * If `projectId` is omitted, applies across all projects (used internally).
 */
export async function cleanupOldRenders(
  retentionHours: number = DEFAULT_RETENTION_HOURS,
  projectId?: string
): Promise<{ deleted: number; errors: number }> {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);

  const where = projectId
    ? and(
        lt(renderJobs.createdAt, cutoff),
        isNotNull(renderJobs.completedAt),
        eq(renderJobs.projectId, projectId)
      )
    : and(lt(renderJobs.createdAt, cutoff), isNotNull(renderJobs.completedAt));

  // Find the matching jobs (so we can remove their files first).
  const oldJobs = await db
    .select({ imageUrl: renderJobs.imageUrl })
    .from(renderJobs)
    .where(where);

  if (oldJobs.length === 0) {
    return { deleted: 0, errors: 0 };
  }

  let errors = 0;
  for (const job of oldJobs) {
    if (!job.imageUrl) continue;
    try {
      // imageUrl looks like ${APP_URL}/storage/renders/img_xxx.png
      const match = job.imageUrl.match(/\/storage\/(.+)$/);
      if (match) await deleteFile(match[1]);
    } catch {
      errors++;
    }
  }

  await db.delete(renderJobs).where(where);

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
