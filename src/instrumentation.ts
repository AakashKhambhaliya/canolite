/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Ensures the database schema and demo data exist before serving requests.
 */

const DATA_DIR = "/app/data";

/**
 * Persistence guard (Task 2). When REQUIRE_PERSISTENT_DATA=1, refuse to boot
 * unless /app/data is a mounted volume (different filesystem device from the
 * image layer's /app) and writable. Running without a volume is exactly what
 * wipes the instance on every Coolify redeploy — fail loudly instead.
 *
 * `fs` is loaded lazily: a top-level static `import fs from "fs"` fails to
 * compile here because Next builds the instrumentation entry for both the
 * nodejs and edge runtimes.
 */
function assertPersistentData(fs: typeof import("fs")): void {
  if (process.env.REQUIRE_PERSISTENT_DATA !== "1") return;

  let appStat: import("fs").Stats;
  try {
    appStat = fs.statSync("/app");
  } catch {
    return; // no /app (local dev) — nothing to guard
  }

  let dataStat: import("fs").Stats;
  try {
    dataStat = fs.statSync(DATA_DIR);
  } catch {
    throw new Error(
      "REQUIRE_PERSISTENT_DATA=1 but " +
        DATA_DIR +
        " does not exist. Mount a persistent volume at " +
        DATA_DIR +
        " (Coolify → Storages)."
    );
  }

  if (dataStat.dev === appStat.dev) {
    throw new Error(
      "REQUIRE_PERSISTENT_DATA=1 but " +
        DATA_DIR +
        " is not a mounted volume — it lives in the container's image layer " +
        "and will be wiped on every redeploy. Mount a persistent volume at " +
        DATA_DIR +
        " (Coolify → Storages)."
    );
  }

  fs.accessSync(DATA_DIR, fs.constants.W_OK);
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const fs = await import("fs");

    // Fail loudly on an unpersisted /app/data BEFORE touching the database.
    try {
      assertPersistentData(fs);
    } catch (e) {
      console.error(
        "[boot] Fatal: " + (e instanceof Error ? e.message : String(e))
      );
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

    // Instance-marker consistency check (lost/mismatched volume detection).
    const { checkInstanceConsistency } = await import("@/db/seed-data");
    await checkInstanceConsistency(db).catch((e) =>
      console.error("[instance] consistency check failed:", e)
    );

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
