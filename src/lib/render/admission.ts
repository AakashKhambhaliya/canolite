import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { projects, renderJobs } from "@/db/schema";
export class RenderAdmissionError extends Error {
  constructor(message: string, readonly status = 429) { super(message); }
}
export async function insertJobs(projectId: string, rows: (typeof renderJobs.$inferInsert)[], single = false) {
  return db.transaction(async tx => {
    // Serialize admission with other producers (including other processes),
    // not just the much later operation that actually opens a browser page.
    const [project] = await tx.select({id:projects.id}).from(projects).where(eq(projects.id,projectId)).for("update");
    if (!project) throw new Error("Project not found");
    const [pending] = await tx.select({n:count()}).from(renderJobs).where(and(eq(renderJobs.projectId,projectId),inArray(renderJobs.status,["queued","processing"])));
    if (pending.n + rows.length > 1000) throw new RenderAdmissionError("Project render backlog is full; retry after pending jobs finish");
    const insert = tx.insert(renderJobs).values(rows);
    if (single) return await insert.returning();
    await insert;
    return [];
  });
}
export async function renderBody(request: Request) {
  const limit = 4 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new RenderAdmissionError("Render request exceeds 4 MiB",413);
  const reader = request.body?.getReader();
  if (!reader) throw new RenderAdmissionError("Missing render request",400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try { for (;;) {
    const {done,value} = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new RenderAdmissionError("Render request exceeds 4 MiB",413); }
    chunks.push(value);
  } } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks,size).toString("utf8")); }
  catch { throw new RenderAdmissionError("Invalid render request",400); }
}
