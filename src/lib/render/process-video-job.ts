import { db } from "@/db";
import { renderJobs, templates } from "@/db/schema";
import { eq } from "drizzle-orm";
import { applyModifications } from "./apply-modifications";
import { renderVideoToBuffer } from "@/lib/video/render-video";
import { uploadFile, toAbsoluteUrl } from "@/lib/storage";
import { safeFetch } from "@/lib/ssrf";

const WEBHOOK_TIMEOUT_MS = 10_000;

export async function processVideoJob(uid: string, opts: { rethrow?: boolean } = {}): Promise<void> {
  const startTime = Date.now();
  try {
    await db.update(renderJobs).set({ status: "processing", progress: 1 }).where(eq(renderJobs.uid, uid));

    const [job] = await db.select().from(renderJobs).where(eq(renderJobs.uid, uid)).limit(1);
    if (!job) throw new Error(`Video render job not found: ${uid}`);

    const [template] = await db.select().from(templates).where(eq(templates.id, job.templateId)).limit(1);
    if (!template) throw new Error(`Template not found for video job: ${uid}`);

    const { modifiedJson } = applyModifications(template.designJson, (job.modifications as any) || []);
    const videoDefaults = (template.videoDefaults as any) || {};
    const qualityPreset = (job.quality || videoDefaults.quality || 23) as any;

    const result = await renderVideoToBuffer({
      uid,
      designJson: modifiedJson,
      projectId: job.projectId,
      width: template.width,
      height: template.height,
      fps: job.fps || videoDefaults.fps || undefined,
      durationSec: job.durationSec || videoDefaults.durationSec || undefined,
      quality: qualityPreset,
      scale: job.scale || 1,
      background: job.background,
      onProgress: async (progress) => {
        await db.update(renderJobs).set({ progress }).where(eq(renderJobs.uid, uid));
      },
    });

    const videoUrl = await uploadFile(`renders/${uid}.mp4`, result.buffer, "video/mp4");
    const posterUrl = result.posterBuffer.length
      ? await uploadFile(`renders/${uid}.poster.jpg`, result.posterBuffer, "image/jpeg")
      : null;
    const durationMs = Date.now() - startTime;

    await db
      .update(renderJobs)
      .set({
        status: "done",
        imageUrl: videoUrl,
        outputKind: "video",
        outputUrl: videoUrl,
        posterUrl,
        mimeType: "video/mp4",
        durationSec: Math.ceil(result.durationSec),
        fps: result.fps,
        frameCount: result.frameCount,
        progress: 100,
        durationMs,
        completedAt: new Date(),
      })
      .where(eq(renderJobs.uid, uid));

    if (job.webhookUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        await safeFetch(job.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Canolite-Event": "video.completed",
          },
          body: JSON.stringify({
            event: "video.completed",
            uid: job.uid,
            batch_uid: job.batchUid,
            status: "done",
            video_url: toAbsoluteUrl(videoUrl),
            poster_url: toAbsoluteUrl(posterUrl),
            duration_sec: result.durationSec,
            fps: result.fps,
            frame_count: result.frameCount,
            duration_ms: durationMs,
          }),
          signal: controller.signal,
        });
      } catch (webhookErr) {
        console.error(`[video] Webhook failed for ${uid}:`, webhookErr);
      } finally {
        clearTimeout(timer);
      }
    }

    console.log(`[video] Completed ${uid} (${durationMs}ms)`);
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.error(`[video] Failed ${uid}:`, error?.message || error);
    await db
      .update(renderJobs)
      .set({
        status: "failed",
        errorMessage: error?.message || "Unknown error",
        durationMs,
        completedAt: new Date(),
      })
      .where(eq(renderJobs.uid, uid));
    if (opts.rethrow) throw error;
  }
}

export async function processVideoBatch(uids: string[]): Promise<void> {
  for (const uid of uids) await processVideoJob(uid);
}
