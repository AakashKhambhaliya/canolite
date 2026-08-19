/**
 * Standalone backup script: `npm run db:backup`.
 * Ensures the DB is initialized, then writes a manual backup to
 * /app/data/backups (see src/lib/backup.ts).
 */
import { ensureDb } from "./index";
import { createBackup } from "../lib/backup";

ensureDb()
  .then(() => createBackup("manual"))
  .then((dir) => {
    if (dir) console.log(`\n✅ Backup written to ${dir}`);
    else console.log("\n⚠️ Backup skipped (see logs above).");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Backup failed:", err);
    process.exit(1);
  });
