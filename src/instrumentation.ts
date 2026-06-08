/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Ensures the database schema and demo data exist before serving requests.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureDb } = await import("@/db");
    await ensureDb();
    const { ensureBucket } = await import("@/lib/storage");
    await ensureBucket();

    // Run cleanup on boot + every hour, honoring each project's retention.
    const { cleanupScheduled } = await import("@/lib/render/cleanup");
    cleanupScheduled().catch(() => {}); // don't block boot
    setInterval(() => {
      cleanupScheduled().catch((e) =>
        console.error("[cleanup] Periodic cleanup failed:", e)
      );
    }, 60 * 60 * 1000); // every 1 hour
  }
}
