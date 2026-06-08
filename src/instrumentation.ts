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
  }
}
