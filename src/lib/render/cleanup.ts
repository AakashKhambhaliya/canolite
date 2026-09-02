/**
 * Auto-cleanup for rendered images.
 *
 * Deletes render job rows and their corresponding image files from disk
 * after a configurable retention period. Keeps the storage lean.
 */
import { db } from "@/db";
import { renderJobs, projects } from "@/db/schema";
import { lt, and, isNotNull, eq, inArray, sql } from "drizzle-orm";
import { deleteFile } from "@/lib/storage";

const DEFAULT_RETENTION_HOURS = 24;

/**
 * Fail any render left mid-flight by a previous process.
 *
 * Renders run IN-PROCESS: the job row is the only durable record of one, while
 * the extracted frames, the Chromium page and the ffmpeg child all live in this
 * process's memory and scratch space. A restart — redeploy, crash, OOM kill —
 * therefore abandons whatever was rendering, with nothing left to resume from.
 *
 * Nothing used to reconcile those rows, and none of the other mechanisms reach
 * them: the retention sweep only removes jobs that have a `completedAt`, and
 * the render timeout died with the process that was enforcing it. So the row
 * sat at `processing` — showing the 1% written when the job started, before any
 * real progress is reported — indefinitely, and a caller polling for the result
 * waited on a render that no longer existed anywhere but the database.
 *
 * Marking them failed at boot is the honest outcome: the work is genuinely gone
 * and the caller can retry.
 *
 * This assumes a single app instance, which is the design (embedded PostgreSQL,
 * in-process rendering) — "processing" can only mean "owned by the process that
 * just died". Running several replicas against one database would need this
 * scoped per instance instead.
 *
 * Deliberately does NOT touch `queued`: with an external BullMQ worker those
 * are still claimable, and in the in-process path a job is only queued for the
 * instant before rendering starts.
 */
export async function failOrphanedRenders(): Promise<number> {
  const orphans = await db
    .select({ uid: renderJobs.uid })
    .from(renderJobs)
    .where(eq(renderJobs.status, "processing"));

  if (orphans.length === 0) return 0;

  await db
    .update(renderJobs)
    .set({
      status: "failed",
      errorMessage:
        "The server restarted while this render was in progress, so it was " +
        "abandoned. Submit it again.",
      completedAt: new Date(),
    })
    .where(eq(renderJobs.status, "processing"));

  console.warn(
    `[render] Marked ${orphans.length} interrupted render(s) as failed: ` +
      orphans.map((o) => o.uid).join(", ")
  );
  return orphans.length;
}

/**
 * Rows eligible for cleanup: completed, and older than the retention cutoff.
 *
 * The cutoff is computed by PostgreSQL, not by JavaScript, because
 * `render_jobs.created_at` is `timestamp WITHOUT time zone` filled in by the
 * column's own `defaultNow()` — so it holds the database server's LOCAL wall
 * clock. A cutoff built as `new Date(Date.now() - h)` is serialized as UTC and
 * loses its offset on the way into that column type, so the two sides were
 * being compared in different time zones: on UTC+5:30 every render survived
 * 5.5 hours past its retention period, and west of UTC they were deleted
 * early. Comparing against the database's own `now()` keeps both sides on the
 * same clock whatever the server's zone.
 */
function cleanableWhere(retentionHours: number, projectId?: string) {
  const cutoff = sql`now() - make_interval(hours => ${retentionHours})`;
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

interface StoredJobFiles {
  imageUrl: string | null;
  outputUrl: string | null;
  posterUrl: string | null;
}

/**
 * Remove the files behind a set of jobs. Returns the number of failures.
 *
 * De-duplicated per job: image jobs store the same URL in imageUrl and
 * outputUrl, and deleting the same key twice would count a phantom error.
 * Video jobs additionally write a poster alongside the MP4 — sweeping only
 * imageUrl left one orphaned JPEG per video render on disk forever.
 */
async function deleteStoredFiles(jobs: StoredJobFiles[]): Promise<number> {
  let errors = 0;
  for (const job of jobs) {
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
  return errors;
}

/** How many renders the project has in total, regardless of age or status. */
export async function countRenders(projectId: string): Promise<number> {
  const rows = await db
    .select({ id: renderJobs.id })
    .from(renderJobs)
    .where(eq(renderJobs.projectId, projectId));
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

  const errors = await deleteStoredFiles(oldJobs);

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
 * Delete EVERY render in a project right now, whatever its age or status.
 *
 * The retention sweep is deliberately conservative — it only touches finished
 * jobs past the cutoff — which meant the "Clean Now" button did nothing at all
 * on a project whose renders were all newer than the retention period, and
 * looked broken. Manual deletion is a separate, explicit intent, so it gets its
 * own path rather than being faked by temporarily lowering the retention.
 *
 * Jobs still queued or processing are included: the caller asked for
 * everything, and a render whose row disappears mid-flight simply finds nothing
 * to update when it finishes (the row is gone, the UPDATE is a no-op).
 */
export async function purgeAllRenders(
  projectId: string
): Promise<{ deleted: number; errors: number }> {
  const jobs = await db
    .select({
      id: renderJobs.id,
      imageUrl: renderJobs.imageUrl,
      outputUrl: renderJobs.outputUrl,
      posterUrl: renderJobs.posterUrl,
    })
    .from(renderJobs)
    .where(eq(renderJobs.projectId, projectId));

  if (jobs.length === 0) return { deleted: 0, errors: 0 };

  const errors = await deleteStoredFiles(jobs);

  await db.delete(renderJobs).where(
    inArray(
      renderJobs.id,
      jobs.map((j) => j.id)
    )
  );

  console.log(
    `[cleanup] Purged all ${jobs.length} renders for project ${projectId} ` +
      `(${errors} file errors)`
  );
  return { deleted: jobs.length, errors };
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
