/**
 * Standalone seed script: `npm run db:seed`.
 * Delegates to ensureDb(), which runs migrations and seeds if empty.
 */
import { ensureDb } from "./index";

ensureDb()
  .then(() => {
    console.log("\n🎉 Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
