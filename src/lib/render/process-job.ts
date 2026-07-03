/**
 * Process a single render job end-to-end.
 *
 *   load job + template → apply modifications → render (Fabric/Chromium) →
 *   Sharp post-process → store → update job → fire webhook
 *
 * Shared by the synchronous API routes and the BullMQ worker. Always resolves
 * (errors are recorded on the job row) unless `rethrow` is set.
 */
import { db } from "@/db";
import { renderJobs, templates, assets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { applyModifications } from "./apply-modifications";
import { inlineExternalImages } from "./inline-images";
import { renderToBuffer } from "./render-image";
import { uploadFile, toAbsoluteUrl } from "@/lib/storage";
import { safeFetch } from "@/lib/ssrf";

const WEBHOOK_TIMEOUT_MS = 10_000;

export async function processRenderJob(
  uid: string,
  opts: { rethrow?: boolean } = {}
): Promise<void> {
  const startTime = Date.now();

  try {
    await db
      .update(renderJobs)
      .set({ status: "processing" })
      .where(eq(renderJobs.uid, uid));

    const [job] = await db
      .select()
      .from(renderJobs)
      .where(eq(renderJobs.uid, uid))
      .limit(1);
    if (!job) throw new Error(`Render job not found: ${uid}`);

    const [template] = await db
      .select()
      .from(templates)
      .where(eq(templates.id, job.templateId))
      .limit(1);
    if (!template) throw new Error(`Template not found for job: ${uid}`);

    const { modifiedJson } = applyModifications(
      template.designJson,
      (job.modifications as any) || []
    );

    // Fetch external image URLs server-side and inline them as data: URLs.
    // The headless render page can't reliably load arbitrary external URLs
    // (CORS, hotlink protection, redirects like Google Drive share links).
    const renderJson = await inlineExternalImages(modifiedJson);

    // Project's uploaded custom fonts, so server renders match the editor.
    const fontAssets = await db
      .select()
      .from(assets)
      .where(
        and(eq(assets.projectId, job.projectId), eq(assets.type, "font"))
      );
    const customFonts = fontAssets.map((a: any) => ({
      family: a.name.replace(/\.[^.]+$/, ""),
      url: a.url,
    }));

    const { buffer, ext } = await renderToBuffer({
      designJson: renderJson,
      width: template.width,
      height: template.height,
      format: (job.format as any) || "png",
      quality: job.quality ?? 90,
      scale: job.scale ?? 1,
      background: job.background || undefined,
      customFonts,
    });

    const key = `renders/${uid}.${ext}`;
    const imageUrl = await uploadFile(key, buffer, `image/${ext}`);
    const durationMs = Date.now() - startTime;

    await db
      .update(renderJobs)
      .set({ status: "done", imageUrl, durationMs, completedAt: new Date() })
      .where(eq(renderJobs.uid, uid));

    if (job.webhookUrl) {
      // Bound the delivery so a slow or hung webhook endpoint can't stall the
      // render worker (which processes jobs serially).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        // safeFetch re-validates every redirect hop against the SSRF guard —
        // job.webhookUrl was checked at creation time, but a plain fetch()
        // would still follow a same-URL redirect to an internal address.
        await safeFetch(job.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Canolite-Event": "render.completed",
          },
          body: JSON.stringify({
            event: "render.completed",
            uid: job.uid,
            batch_uid: job.batchUid,
            status: "done",
            image_url: toAbsoluteUrl(imageUrl),
            duration_ms: durationMs,
          }),
          signal: controller.signal,
        });
      } catch (webhookErr) {
        console.error(`[render] Webhook failed for ${uid}:`, webhookErr);
      } finally {
        clearTimeout(timer);
      }
    }

    console.log(`[render] Completed ${uid} (${durationMs}ms)`);
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.error(`[render] Failed ${uid}:`, error?.message || error);

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

/**
 * Process a list of jobs one at a time (keeps a single Chromium page in flight).
 */
export async function processBatch(uids: string[]): Promise<void> {
  for (const uid of uids) {
    await processRenderJob(uid);
  }
}
