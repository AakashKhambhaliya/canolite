import { rasterExportIssue } from "@/lib/design/raster-budget";
import { db } from "@/db";
import { renderJobs, templates } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { applyModifications } from "./apply-modifications";
import { renderVideoToBuffer } from "@/lib/video/render-video";
import { getFileUrl, toAbsoluteUrl } from "@/lib/storage";
import { runJob } from "./job-lifecycle";
import { availableFontsForProject } from "./prepare-design";

export function processVideoJob(uid: string, opts: {rethrow?: boolean} = {}) {
  return runJob(uid, "video", opts, async job => {
    const [template] = await db.select().from(templates).where(and(eq(templates.id,job.templateId),eq(templates.projectId,job.projectId))).limit(1);
    if (!template) throw new Error("Template not found for video job");
    const issue = rasterExportIssue(template.width,template.height,job.scale || 1);
    if (issue) throw new Error(issue);
    const {modifiedJson} = applyModifications(template.designJson,(job.modifications as any) || [], await availableFontsForProject(job.projectId));
    const defaults = template.videoDefaults || {};
    const result = await renderVideoToBuffer({uid, designJson:modifiedJson,projectId:job.projectId,width:template.width,height:template.height,
      fps:job.fps || defaults.fps,durationSec:job.durationSec || defaults.durationSec,quality:job.quality ?? defaults.crf ?? 23, scale:job.scale || 1,background:job.background,
      onProgress:async progress => {
        // Progress is cosmetic: a failed write must not fail the render.
        try { await db.update(renderJobs).set({progress}).where(and(eq(renderJobs.id,job.id),eq(renderJobs.status,"processing"))); }
        catch (error) { console.warn(`[render] Could not record progress for ${uid}:`, error instanceof Error ? error.message : error); }
      }});
    const videoKey = `renders/${uid}.mp4`, posterKey = `renders/${uid}.poster.jpg`;
    const videoUrl = getFileUrl(videoKey), posterUrl = result.posterBuffer.length ? getFileUrl(posterKey) : null;
    const files = [{key:videoKey,bytes:result.buffer,type:"video/mp4"}];
    if (posterUrl) files.push({key:posterKey,bytes:result.posterBuffer,type:"image/jpeg"});
    return {files, columns:{imageUrl:videoUrl,outputKind:"video",outputUrl:videoUrl,posterUrl,mimeType:"video/mp4",durationSec:Math.ceil(result.durationSec),fps:result.fps,frameCount:result.frameCount},
      event:{video_url:toAbsoluteUrl(videoUrl),poster_url:toAbsoluteUrl(posterUrl),duration_sec:result.durationSec,fps:result.fps,frame_count:result.frameCount}};
  });
}
/** Never rejects: one item's failure must not strand the rest of the batch. */
export async function processVideoBatch(uids: string[]) {
  for (const uid of uids) {
    try { await processVideoJob(uid); }
    catch (error) { console.error(`[render] Video batch item ${uid} failed:`, error instanceof Error ? error.message : error); }
  }
}
