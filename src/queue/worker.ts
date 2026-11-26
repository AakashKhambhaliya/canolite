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
import { closeDatabase, ensureDb, takeOverDatabaseShutdown } from "../db";

// This entrypoint drains its workers before closing the DB; stop the db
// module's own signal handler from closing the pool and exiting mid-job.
takeOverDatabaseShutdown();

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CONCURRENCY = config.RENDER_CONCURRENCY;

// Parse Redis URL for BullMQ connection options
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  const db = parseInt(parsed.pathname.replace(/^\//, "") || "0", 10);
  return {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port || "6379", 10),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isFinite(db) && db >= 0 ? db : 0,
    // rediss:// means TLS.
    ...(parsed.protocol === "rediss:" ? { tls: { servername: parsed.hostname } } : {}),
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
    // Started below, only once the database is ready.
    autorun: false,
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
  { connection: redisOpts, concurrency: 1, autorun: false }
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

// Graceful shutdown: let in-flight jobs finish, close the queues, THEN close
// the database. Runs once even if both signals arrive.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[Worker] Shutting down...");
  try {
    await Promise.all([worker.close(), videoWorker.close()]);
    await Promise.all([renderQueue.close(), videoQueue.close()]);
  } catch (error) {
    console.error("[Worker] Error during shutdown:", error);
  } finally {
    await closeDatabase("worker shutdown");
    process.exit(0);
  }
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.log("[Worker] Starting Canolite render worker...");

// The render pipeline reads and writes the DB. In the default embedded-Postgres
// mode nothing exists until ensureDb() has started it, so no job may be picked
// up before that.
ensureDb()
  .then(() => {
    void worker.run().catch((err) => console.error("[Worker] Error:", err));
    void videoWorker.run().catch((err) => console.error("[Worker] Video error:", err));
  })
  .catch(async (error) => {
    console.error("[Worker] Database initialisation failed:", error);
    await closeDatabase("worker startup failure");
    process.exit(1);
  });
