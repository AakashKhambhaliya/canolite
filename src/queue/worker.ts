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
import { processVideoJob } from "../lib/render/process-video-job";
import { config } from "../lib/config";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CONCURRENCY = config.RENDER_CONCURRENCY;

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
export const videoQueue = new Queue("render-video", { connection: redisOpts });

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

const videoWorker = new Worker(
  "render-video",
  async (job) => {
    const { uid } = job.data;
    console.log(`[Worker] Processing video job: ${uid}`);
    await processVideoJob(uid, { rethrow: true });
  },
  { connection: redisOpts, concurrency: 1 }
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

videoWorker.on("ready", () => {
  console.log("[Worker] Video worker ready — concurrency: 1");
});
videoWorker.on("completed", (job) => console.log(`[Worker] Video job completed: ${job.id}`));
videoWorker.on("failed", (job, err) => console.error(`[Worker] Video job failed: ${job?.id}`, err.message));
videoWorker.on("error", (err) => console.error("[Worker] Video error:", err));

// Graceful shutdown
async function shutdown() {
  console.log("[Worker] Shutting down...");
  await worker.close();
  await videoWorker.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[Worker] Starting Canolite render worker...");
