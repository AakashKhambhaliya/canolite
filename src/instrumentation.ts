/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Ensures the database schema and demo data exist before serving requests.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureDb } = await import("@/db");
    await ensureDb();

    const { ensureBucket, migrateLegacyStorage } = await import(
      "@/lib/storage"
    );
    // One-time move of any files left at the legacy `public/storage` location
    // into the configured STORAGE_DIR, before we create/use the bucket.
    await migrateLegacyStorage();
    await ensureBucket();

    // Run cleanup on boot + every hour, honoring each project's retention.
    const { cleanupScheduled } = await import("@/lib/render/cleanup");
    cleanupScheduled().catch(() => {}); // don't block boot
    setInterval(() => {
      cleanupScheduled().catch((e) =>
        console.error("[cleanup] Periodic cleanup failed:", e)
      );
    }, 60 * 60 * 1000); // every 1 hour

    // Backfill previews for templates that don't have one yet. Fire-and-forget:
    // renders are slow and must never block boot or request serving.
    const { backfillThumbnails } = await import("@/lib/render/thumbnail");
    backfillThumbnails().catch((e) =>
      console.error("[thumbnail] Backfill failed:", e)
    );
  }
}
