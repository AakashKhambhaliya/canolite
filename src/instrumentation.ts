/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Ensures the database schema and demo data exist before serving requests.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail loudly on an unpersisted /app/data BEFORE touching the database.
    const { persistentDataStatus } = await import("@/lib/persistence");
    const guard = persistentDataStatus();
    if (!guard.ok) {
      console.error("[boot] Fatal: " + (guard.reason || "unpersisted data"));
      process.exit(1);
      return;
    }

    const { ensureDb, db } = await import("@/db");
    await ensureDb();

    const { ensureBucket, migrateLegacyStorage } = await import(
      "@/lib/storage"
    );
    // One-time move of any files left at the legacy `public/storage` location
    // into the configured STORAGE_DIR, before we create/use the bucket.
    await migrateLegacyStorage();
    await ensureBucket();

    // Renders need a Chromium whose build number matches the installed
    // Playwright. Deployments that don't use our Dockerfile (bare VPS, or a
    // buildpack like Nixpacks) have historically started fine and then failed
    // on the first render with an opaque "Executable doesn't exist" error.
    // Say it at boot instead, where an operator will actually see it.
    try {
      const { chromium } = await import("playwright");
      const fs = await import("fs");
      const exe = chromium.executablePath();
      if (!fs.existsSync(exe)) {
        console.error(
          "[render] Chromium is missing — renders WILL fail.\n" +
            "[render]   expected at: " +
            exe +
            "\n[render]   fix with:    npx playwright install --with-deps chromium" +
            (process.env.PLAYWRIGHT_BROWSERS_PATH
              ? ""
              : "\n[render]   note: PLAYWRIGHT_BROWSERS_PATH is unset, so Playwright is " +
                "using the default per-user cache. The official Docker image sets it to " +
                "/ms-playwright and ships the browser; a non-Docker deploy must install it.")
        );
      }
    } catch (e) {
      console.error(
        "[render] Could not verify the Chromium install:",
        e instanceof Error ? e.message : e
      );
    }

    // Instance-marker consistency check (lost/mismatched volume detection).
    const { checkInstanceConsistency } = await import("@/db/seed-data");
    await checkInstanceConsistency(db).catch((e) =>
      console.error("[instance] consistency check failed:", e)
    );

    // Any render that was in flight when the previous process died is gone —
    // it lived in that process's memory. Fail those rows now, or they sit at
    // "processing" forever and every caller polling one waits indefinitely.
    const { failOrphanedRenders, cleanupScheduled } = await import(
      "@/lib/render/cleanup"
    );
    await failOrphanedRenders().catch((e) =>
      console.error("[render] Could not reconcile interrupted renders:", e)
    );

    // Run cleanup on boot + every hour, honoring each project's retention.
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
