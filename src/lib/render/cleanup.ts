/**
 * Auto-cleanup for rendered images.
 *
 * Deletes render job rows and their corresponding image files from disk
 * after a configurable retention period. Keeps the storage lean.
 */
import { db } from "@/db";
import { renderJobs, projects } from "@/db/schema";
import { lt, and, isNotNull, eq, or, sql, type SQL } from "drizzle-orm";
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
  const eligible = or(eq(renderJobs.status, "deleting"), and(lt(renderJobs.createdAt, cutoff), isNotNull(renderJobs.completedAt)));
  return projectId ? and(eligible, eq(renderJobs.projectId, projectId)) : eligible;
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

// Delete the tracked files plus deterministic partial outputs from interrupted
// publication. A failure leaves a durable tombstone for the next sweep.
export async function deleteRenderFiles(job: {uid:string; imageUrl:string|null; outputUrl:string|null; posterUrl:string|null}, unlink = deleteFile) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(job.uid)) throw new Error("Invalid render identifier");
  const keys = new Set(["png","jpg","webp","mp4","poster.jpg"].map(ext => `renders/${job.uid}.${ext}`));
  for (const url of [job.imageUrl,job.outputUrl,job.posterUrl]) {
    if (!url) continue;
    const pathname = new URL(url,"https://storage.invalid").pathname;
    if (!pathname.startsWith("/storage/renders/")) throw new Error("Unexpected stored render URL");
    const key = decodeURIComponent(pathname.slice("/storage/".length));
    if (!/^renders\/[a-zA-Z0-9._-]+$/.test(key)) throw new Error("Invalid render file name");
    keys.add(key);
  }
  for (const key of keys) await unlink(key);
}
export async function deleteRenderRow(id:string, where?:SQL) {
  return db.transaction(async tx => {
    // Same row and lock as runJob's publication; re-check scope/age under lock.
    const [job] = await tx.select({uid:renderJobs.uid,imageUrl:renderJobs.imageUrl,outputUrl:renderJobs.outputUrl,posterUrl:renderJobs.posterUrl})
      .from(renderJobs).where(and(eq(renderJobs.id,id),where)).for("update");
    if (!job) return "missing";
    try { await deleteRenderFiles(job); } catch {
      await tx.update(renderJobs).set({status:"deleting", errorMessage:"File deletion pending; will retry."}).where(eq(renderJobs.id,id));
      return "pending";
    }
    await tx.delete(renderJobs).where(eq(renderJobs.id,id));
    return "deleted";
  });
}
async function removeMatching(where?:SQL) {
  const rows = await db.select({id:renderJobs.id}).from(renderJobs).where(where);
  let deleted = 0, errors = 0;
  for (const {id} of rows) {
    const outcome = await deleteRenderRow(id, where);
    if (outcome === "deleted") deleted++;
    if (outcome === "pending") errors++;
  }
  if (errors) console.error(`[cleanup] ${errors} render deletions pending retry`);
  return {deleted, errors};
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
  return removeMatching(cleanableWhere(retentionHours, projectId));
}

export function purgeAllRenders(projectId: string) {
  return removeMatching(eq(renderJobs.projectId, projectId));
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
