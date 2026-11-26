import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { uploadFile } from "@/lib/storage";
import { RenderCapacityError, renderSignal, withMediaProject, withRenderSlot } from "@/lib/security/render-budget";
import { notifyJob } from "./job-webhook";

import { renderErrorMessage } from "./error-message";

type Job = typeof renderJobs.$inferSelect;
type Product = {
  files: {key: string; bytes: Buffer; type: string}[];
  columns: Partial<typeof renderJobs.$inferInsert>;
  event: Record<string, unknown>;
};

/**
 * How long an admitted job may wait for a render slot when the gate's waiting
 * list is full, before it is failed. Admission already caps how many jobs can
 * exist, so this only bounds how long a burst is allowed to drain.
 */
const SLOT_WAIT_LIMIT_MS = 60 * 60 * 1000;
const SLOT_RETRY_MIN_MS = 1_000;
const SLOT_RETRY_JITTER_MS = 2_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A row lock serializes publication with deletion. A deleted job may finish
 * computing but cannot recreate its files or send a completion notification.
 *
 * The job is claimed (queued → processing) only AFTER a render slot has been
 * acquired. Claiming first meant a burst larger than the gate's waiting list
 * marked admitted jobs `processing`, then `failed` with "capacity is full",
 * and counted the time spent queueing as render duration. Now a job that can't
 * get a slot stays `queued` and retries until one frees up.
 *
 * Never rejects unless `opts.rethrow` is set: callers fire this and forget it,
 * so a DB outage while recording a failure must not become an unhandled
 * rejection that takes the process down. */
export async function runJob(uid: string, kind: "image" | "video", opts: {rethrow?: boolean}, produce: (job: Job) => Promise<Product>) {
  const event = kind === "video" ? "video" : "render";
  const waitDeadline = Date.now() + SLOT_WAIT_LIMIT_MS;
  let started = Date.now();
  let claimed: Job | undefined;
  let published: Record<string, unknown> | undefined;
  let failure: unknown;

  for (;;) {
    try {
      await withRenderSlot(async () => {
        [claimed] = await db.update(renderJobs).set({status:"processing",progress:1})
          .where(and(eq(renderJobs.uid,uid),eq(renderJobs.status,"queued"))).returning();
        if (!claimed) return;
        started = Date.now();
        const job = claimed;
        const product = await withMediaProject(job.projectId, () => produce(job));
        renderSignal()?.throwIfAborted();
        await db.transaction(async tx => {
          const [live] = await tx.select({id:renderJobs.id}).from(renderJobs)
            .where(and(eq(renderJobs.id,job.id),eq(renderJobs.status,"processing"))).for("update");
          if (!live) return;
          for (const file of product.files) { renderSignal()?.throwIfAborted(); await uploadFile(file.key,file.bytes,file.type); }
          renderSignal()?.throwIfAborted();
          const durationMs = Date.now()-started;
          await tx.update(renderJobs).set({...product.columns,status:"done",progress:100,durationMs,completedAt:new Date()}).where(eq(renderJobs.id,live.id));
          return { ...product.event, status:"done", duration_ms:durationMs };
        }).then(result => { published = result; });
      }, kind);
      break;
    } catch (error) {
      // No slot yet and nothing claimed: the job is still `queued`. Wait and
      // try again rather than failing work that was already admitted.
      if (error instanceof RenderCapacityError && !claimed && Date.now() < waitDeadline) {
        await sleep(SLOT_RETRY_MIN_MS + Math.random() * SLOT_RETRY_JITTER_MS);
        continue;
      }
      failure = error;
      break;
    }
  }

  if (published && claimed) {
    try {
      await notifyJob(claimed, `${event}.completed`, published);
    } catch (error) {
      console.error(`[render] Completion notification failed for ${uid}:`, error instanceof Error ? error.message : error);
    }
  } else if (failure) {
    try {
      // Fail the row whether or not this call had claimed it yet (a job that
      // waited past the slot deadline is still `queued`).
      const job = claimed;
      const [failed] = await db.update(renderJobs).set({status:"failed",errorMessage:renderErrorMessage(failure),durationMs:job ? Date.now()-started : undefined,completedAt:new Date()})
        .where(job
          ? and(eq(renderJobs.id,job.id),eq(renderJobs.status,"processing"))
          : and(eq(renderJobs.uid,uid),eq(renderJobs.status,"queued")))
        .returning();
      if (failed) await notifyJob(job ?? failed, `${event}.failed`, {status:"failed",error:"Render failed; see authenticated job status."});
    } catch (reportError) {
      console.error(`[render] Could not record failure for ${uid}:`, reportError instanceof Error ? reportError.message : reportError);
    }
    console.error(`[render] Failed ${uid}:`, failure instanceof Error ? failure.message : "Render failed");
    if (opts.rethrow) throw failure;
  }
}
