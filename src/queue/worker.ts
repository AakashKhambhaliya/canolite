/**
 * Canolite Render Worker
 *
 * Processes render jobs from the BullMQ queue using the shared render
 * pipeline (Fabric/Chromium → Sharp → storage). Optional: the app also
 * renders synchronously, so a separate worker/Redis is not required locally.
 *
 * Run: npm run worker
 */

import { Worker, Queue } from "bullmq";
import { processRenderJob } from "../lib/render/process-job";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY || "3", 10);

// Parse Redis URL for BullMQ connection options
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port || "6379", 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null as any,
  };
}

const redisOpts = parseRedisUrl(REDIS_URL);

// Queue
export const renderQueue = new Queue("render", { connection: redisOpts });

// Worker
const worker = new Worker(
  "render",
  async (job) => {
    const { uid } = job.data;
    console.log(`[Worker] Processing render job: ${uid}`);
    // Shared pipeline: apply mods → Fabric/Chromium → Sharp → store → webhook.
    await processRenderJob(uid, { rethrow: true });
  },
  {
    connection: redisOpts,
    concurrency: CONCURRENCY,
    limiter: {
      max: CONCURRENCY,
      duration: 1000,
    },
  }
);

worker.on("ready", () => {
  console.log(`[Worker] Ready — concurrency: ${CONCURRENCY}`);
});

worker.on("completed", (job) => {
  console.log(`[Worker] Job completed: ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job failed: ${job?.id}`, err.message);
});

worker.on("error", (err) => {
  console.error("[Worker] Error:", err);
});

// Graceful shutdown
async function shutdown() {
  console.log("[Worker] Shutting down...");
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[Worker] Starting Canolite render worker...");
