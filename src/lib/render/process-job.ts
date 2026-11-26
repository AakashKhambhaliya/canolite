import { db } from "@/db";
import { templates } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { applyModifications } from "./apply-modifications";
import { availableFontsForProject, prepareDesignForRender } from "./prepare-design";
import { renderToBuffer } from "./render-image";
import { getFileUrl, toAbsoluteUrl } from "@/lib/storage";
import { runJob } from "./job-lifecycle";

export function processRenderJob(uid: string, opts: { rethrow?: boolean } = {}) {
  return runJob(uid, "image", opts, async job => {
    const [template] = await db.select().from(templates).where(and(eq(templates.id,job.templateId),eq(templates.projectId,job.projectId))).limit(1);
    if (!template) throw new Error("Template not found for render");
    const {modifiedJson} = applyModifications(template.designJson,(job.modifications as any) || [], await availableFontsForProject(job.projectId));
    const design = await prepareDesignForRender(modifiedJson, job.projectId);
    const {buffer,ext,contentType} = await renderToBuffer({...design,width:template.width,height:template.height,format:job.format as any,quality:job.quality ?? 90,scale:job.scale ?? 1,background:job.background || undefined});
    const key = `renders/${uid}.${ext}`;
    const url = getFileUrl(key);
    return { files:[{key,bytes:buffer,type:contentType}], columns:{imageUrl:url,outputUrl:url,outputKind:"image",mimeType:contentType}, event:{image_url:toAbsoluteUrl(url)} };
  });
}
/** Never rejects: one item's failure must not strand the rest of the batch. */
export async function processBatch(uids: string[]) {
  for (const uid of uids) {
    try { await processRenderJob(uid); }
    catch (error) { console.error(`[render] Batch item ${uid} failed:`, error instanceof Error ? error.message : error); }
  }
}
