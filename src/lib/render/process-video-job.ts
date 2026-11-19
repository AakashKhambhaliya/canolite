import { rasterExportIssue } from "@/lib/design/raster-budget";
import { db } from "@/db";
import { renderJobs, templates } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { applyModifications } from "./apply-modifications";
import { renderVideoToBuffer } from "@/lib/video/render-video";
import { getFileUrl, toAbsoluteUrl } from "@/lib/storage";
import { runJob } from "./job-lifecycle";

export function processVideoJob(uid: string, opts: {rethrow?: boolean} = {}) {
  return runJob(uid, "video", opts, async job => {
    const [template] = await db.select().from(templates).where(and(eq(templates.id,job.templateId),eq(templates.projectId,job.projectId))).limit(1);
    if (!template) throw new Error("Template not found for video job");
    const issue = rasterExportIssue(template.width,template.height,job.scale || 1);
    if (issue) throw new Error(issue);
    const {modifiedJson} = applyModifications(template.designJson,(job.modifications as any) || []);
    const defaults = template.videoDefaults || {};
    const result = await renderVideoToBuffer({uid, designJson:modifiedJson,projectId:job.projectId,width:template.width,height:template.height,
      fps:job.fps || defaults.fps,durationSec:job.durationSec || defaults.durationSec,quality:job.quality ?? defaults.crf ?? 23, scale:job.scale || 1,background:job.background,
      onProgress:async progress => { await db.update(renderJobs).set({progress}).where(and(eq(renderJobs.id,job.id),eq(renderJobs.status,"processing"))); }});
    const videoKey = `renders/${uid}.mp4`, posterKey = `renders/${uid}.poster.jpg`;
    const videoUrl = getFileUrl(videoKey), posterUrl = result.posterBuffer.length ? getFileUrl(posterKey) : null;
    const files = [{key:videoKey,bytes:result.buffer,type:"video/mp4"}];
    if (posterUrl) files.push({key:posterKey,bytes:result.posterBuffer,type:"image/jpeg"});
    return {files, columns:{imageUrl:videoUrl,outputKind:"video",outputUrl:videoUrl,posterUrl,mimeType:"video/mp4",durationSec:Math.ceil(result.durationSec),fps:result.fps,frameCount:result.frameCount},
      event:{video_url:toAbsoluteUrl(videoUrl),poster_url:toAbsoluteUrl(posterUrl),duration_sec:result.durationSec,fps:result.fps,frame_count:result.frameCount}};
  });
}
export async function processVideoBatch(uids: string[]) { for (const uid of uids) await processVideoJob(uid); }
