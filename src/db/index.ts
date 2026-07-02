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
    const { PGlite } = require("@electric-sql/pglite");
    const { drizzle } = require("drizzle-orm/pglite");
    const dataDir =
      DATABASE_URL.replace(/^pglite:\/\//, "") || "./.pglite";
    const client = new PGlite(dataDir);
    return drizzle(client, { schema });
  }
  const { Pool } = require("pg");
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  return drizzle(pool, { schema });
}

const globalForDb = globalThis as unknown as {
  __canoliteDb?: DrizzleDb;
  __canoliteReady?: Promise<void>;
};

// Instantiate the backend lazily on first use. Importing this module must NOT
// spin up PGlite: `next build` evaluates every route module (all of which
// import `db`) while collecting page data, and eagerly constructing the PGlite
// WASM instance there crashes the build in slim Linux images ("RuntimeError:
// Aborted()"). Deferring construction to the first query keeps the build pure
// and only starts the DB at runtime, where instrumentation calls ensureDb().
function getDb(): DrizzleDb {
  if (!globalForDb.__canoliteDb) {
    globalForDb.__canoliteDb = buildDb() as DrizzleDb;
  }
  return globalForDb.__canoliteDb;
}

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const real = getDb() as any;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
}) as DrizzleDb;

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
