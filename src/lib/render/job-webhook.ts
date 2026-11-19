import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { sendWebhook } from "@/lib/security/webhook";
export async function readHookConfig(projectId: string) {
  const [config] = await db.select({ webhookUrl: projects.webhookUrl, webhookSecret: projects.webhookSecret })
    .from(projects).where(eq(projects.id, projectId)).limit(1);
  return config;
}
export async function notifyJob(job: {projectId: string; webhookUrl: string | null; uid: string; batchUid: string | null}, event: string, fields: Record<string, unknown>) {
  try {
    const config = await readHookConfig(job.projectId);
    if (config) await sendWebhook(config, job.webhookUrl, event, { uid: job.uid, batch_uid: job.batchUid, ...fields });
  } catch {
    // Delivery cannot fail a completed render; callback URLs may contain credentials in their query.
    console.error(`[webhook] Delivery failed for ${event} (${job.uid})`);
  }
}
