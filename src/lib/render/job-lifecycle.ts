import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { uploadFile } from "@/lib/storage";
import { renderSignal, withMediaProject, withRenderSlot } from "@/lib/security/render-budget";
import { notifyJob } from "./job-webhook";

import { renderErrorMessage } from "./error-message";

type Job = typeof renderJobs.$inferSelect;
type Product = {
  files: {key: string; bytes: Buffer; type: string}[];
  columns: Partial<typeof renderJobs.$inferInsert>;
  event: Record<string, unknown>;
};

/** A row lock serializes publication with deletion. A deleted job may finish
 * computing but cannot recreate its files or send a completion notification. */
export async function runJob(uid: string, kind: "image" | "video", opts: {rethrow?: boolean}, produce: (job: Job) => Promise<Product>) {
  const started = Date.now();
  const event = kind === "video" ? "video" : "render";
  let claimed: Job | undefined;
  let published: Record<string, unknown> | undefined;
  let failure: unknown;
  try {
    [claimed] = await db.update(renderJobs).set({status:"processing",progress:1})
      .where(and(eq(renderJobs.uid,uid),eq(renderJobs.status,"queued"))).returning();
    if (!claimed) return;
    const job = claimed;
    await withRenderSlot(async () => {
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
  } catch (error) { failure = error; }
  if (published && claimed) {
    await notifyJob(claimed, `${event}.completed`, published);
  } else if (failure) {
    if (claimed) {
      const [failed] = await db.update(renderJobs).set({status:"failed",errorMessage:renderErrorMessage(failure),durationMs:Date.now()-started,completedAt:new Date()})
        .where(and(eq(renderJobs.id,claimed.id),eq(renderJobs.status,"processing"))).returning({id:renderJobs.id});
      if (failed) await notifyJob(claimed, `${event}.failed`, {status:"failed",error:"Render failed; see authenticated job status."});
    }
    console.error(`[render] Failed ${uid}:`, failure instanceof Error ? failure.message : "Render failed");
    if (opts.rethrow) throw failure;
  }
}
