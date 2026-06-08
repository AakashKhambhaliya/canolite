import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * Database layer.
 *
 * Supports two backends, selected by DATABASE_URL:
 *  - A real PostgreSQL server  → node-postgres (DATABASE_URL=postgres://...)
 *  - In-process PGlite (WASM)  → zero external services (DATABASE_URL unset or
 *    starting with "pglite"). Data persists to ./.pglite so it survives restarts.
 *
 * PGlite is single-process, so the instance is cached on globalThis to survive
 * Next.js dev HMR reloads.
 */

const DATABASE_URL = process.env.DATABASE_URL || "";
const usePglite = !DATABASE_URL || DATABASE_URL.startsWith("pglite");

// Both backends expose the same drizzle query builder; type against the
// node-postgres variant so the rest of the app gets full inference.
type DrizzleDb = NodePgDatabase<typeof schema>;

function buildDb() {
  if (usePglite) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PGlite } = require("@electric-sql/pglite");
    const { drizzle } = require("drizzle-orm/pglite");
    const dataDir =
      DATABASE_URL.replace(/^pglite:\/\//, "") || "./.pglite";
    const client = new PGlite(dataDir);
    return drizzle(client, { schema });
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require("pg");
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  return drizzle(pool, { schema });
}

const globalForDb = globalThis as unknown as {
  __canoliteDb?: DrizzleDb;
  __canoliteReady?: Promise<void>;
};

export const db: DrizzleDb = (globalForDb.__canoliteDb ?? buildDb()) as DrizzleDb;
if (process.env.NODE_ENV !== "production") globalForDb.__canoliteDb = db;

export type DB = typeof db;

/**
 * Ensure the schema exists and demo data is present. Idempotent — safe to call
 * on every server boot. Runs migrations (PGlite) then seeds if empty.
 */
export async function ensureDb(): Promise<void> {
  if (globalForDb.__canoliteReady) return globalForDb.__canoliteReady;

  globalForDb.__canoliteReady = (async () => {
    // Apply migrations on boot for both backends so deployments need no
    // separate migration step.
    if (usePglite) {
      const { migrate } = require("drizzle-orm/pglite/migrator");
      await migrate(db as any, { migrationsFolder: "./drizzle" });
    } else {
      const { migrate } = require("drizzle-orm/node-postgres/migrator");
      await migrate(db as any, { migrationsFolder: "./drizzle" });
    }
    const { seedIfEmpty, autoProvisionAdminFromEnv } = require("./seed-data");
    await seedIfEmpty(db);
    await autoProvisionAdminFromEnv(db);
  })();

  return globalForDb.__canoliteReady;
}
