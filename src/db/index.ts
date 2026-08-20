import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getEmbeddedPostgres, stopEmbeddedPostgres } from "@/lib/db/embedded";
import * as schema from "./schema";

/**
 * Database layer.
 *
 * Supports two modes, selected by DATABASE_URL:
 *  - DATABASE_URL=postgres://... → external PostgreSQL via node-postgres
 *  - DATABASE_URL unset          → embedded PostgreSQL child process on 127.0.0.1
 *
 * The schema intentionally stays on drizzle-orm/pg-core so jsonb,
 * uuid().defaultRandom(), and text().array() all keep their PostgreSQL
 * semantics in both modes.
 */

const DATABASE_URL = process.env.DATABASE_URL || "";
export const useEmbeddedPostgres = !DATABASE_URL;
const MIGRATION_LOCK_ID = 740_170_001;

type DrizzleDb = NodePgDatabase<typeof schema>;

type PgClientLike = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type PgPoolLike = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  connect: () => Promise<PgClientLike>;
  end: () => Promise<void>;
};

const globalForDb = globalThis as unknown as {
  __canoliteDb?: DrizzleDb;
  __canoliteReady?: Promise<void>;
  __canolitePgPool?: PgPoolLike;
  __canoliteDatabaseUrl?: string;
  __canoliteShutdownInstalled?: boolean;
};

function dbPoolMax(): number {
  const parsed = Number(process.env.DB_POOL_MAX || 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}

function dbIdleTimeoutMillis(): number {
  const parsed = Number(process.env.DB_IDLE_TIMEOUT_MS || 30_000);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 30_000;
}

function dbConnectionTimeoutMillis(): number {
  const parsed = Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10_000);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 10_000;
}

function isLocalDatabaseHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function pgSslOption(connectionString: string): false | { rejectUnauthorized: boolean } {
  const raw = (process.env.DB_SSL || "").toLowerCase();
  if (raw === "disable" || raw === "false" || raw === "0") return false;
  if (raw === "require" || raw === "true" || raw === "1") {
    return { rejectUnauthorized: false };
  }
  try {
    const url = new URL(connectionString);
    return isLocalDatabaseHost(url.hostname) ? false : { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

function assertDatabaseConfig(): void {
  if (DATABASE_URL.startsWith("pglite:")) {
    throw new Error(
      "PGlite has been removed. Unset DATABASE_URL to use the embedded " +
        "PostgreSQL zero-config default, or set DATABASE_URL to a postgres:// " +
        "connection string for external PostgreSQL."
    );
  }
  if (process.env.DATABASE_URL === "") {
    throw new Error(
      "DATABASE_URL is set but empty. Remove the variable entirely to use the " +
        "embedded PostgreSQL default, or set DATABASE_URL to a postgres:// " +
        "connection string for external PostgreSQL."
    );
  }
}

function wrapConnectionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const target = useEmbeddedPostgres ? "embedded PostgreSQL" : "PostgreSQL using DATABASE_URL";
  return new Error(
    `Could not connect to ${target}. Check that the database is reachable, ` +
      "credentials are correct, migrations can run, and DB_SSL is set " +
      "appropriately (use DB_SSL=disable only for trusted private networks). " +
      `Original error: ${message}`
  );
}

function installShutdownHandlers(): void {
  if (globalForDb.__canoliteShutdownInstalled) return;
  globalForDb.__canoliteShutdownInstalled = true;

  const shutdown = async (signal: NodeJS.Signals) => {
    try {
      if (globalForDb.__canolitePgPool) {
        console.log(`[db] Closing PostgreSQL pool on ${signal}`);
        await globalForDb.__canolitePgPool.end();
        globalForDb.__canolitePgPool = undefined;
      }
      if (useEmbeddedPostgres) {
        await stopEmbeddedPostgres();
      }
    } catch (error) {
      console.error("[db] Error while closing database connections:", error);
    }
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
}

function buildDb(connectionString: string) {
  installShutdownHandlers();
  try {
    const { Pool } = require("pg");
    const { drizzle } = require("drizzle-orm/node-postgres");
    const pool = new Pool({
      connectionString,
      max: dbPoolMax(),
      idleTimeoutMillis: dbIdleTimeoutMillis(),
      connectionTimeoutMillis: dbConnectionTimeoutMillis(),
      ssl: pgSslOption(connectionString),
    });
    globalForDb.__canolitePgPool = pool;
    globalForDb.__canoliteDatabaseUrl = connectionString;
    return drizzle(pool, { schema });
  } catch (error) {
    throw wrapConnectionError(error);
  }
}

function getConfiguredDatabaseUrl(): string {
  if (DATABASE_URL) return DATABASE_URL;
  if (globalForDb.__canoliteDatabaseUrl) return globalForDb.__canoliteDatabaseUrl;
  throw new Error(
    "Embedded PostgreSQL has not been started yet. Call ensureDb() before " +
      "using db, or set DATABASE_URL to a postgres:// connection string."
  );
}

function getDb(): DrizzleDb {
  if (!globalForDb.__canoliteDb) {
    globalForDb.__canoliteDb = buildDb(getConfiguredDatabaseUrl()) as DrizzleDb;
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

export async function getDatabaseUrl(): Promise<string> {
  return prepareDatabaseUrl();
}

async function prepareDatabaseUrl(): Promise<string> {
  if (DATABASE_URL) return DATABASE_URL;
  const embedded = await getEmbeddedPostgres();
  globalForDb.__canoliteDatabaseUrl = embedded.connectionString;
  return embedded.connectionString;
}

async function connectivityCheck(): Promise<void> {
  try {
    const connectionString = await prepareDatabaseUrl();
    if (!globalForDb.__canoliteDb) {
      globalForDb.__canoliteDb = buildDb(connectionString) as DrizzleDb;
    }
    if (globalForDb.__canolitePgPool) {
      await globalForDb.__canolitePgPool.query("select 1");
      return;
    }
    await (db as any).execute(sql`select 1`);
  } catch (error) {
    throw wrapConnectionError(error);
  }
}

async function runLegacyPgliteMigrationIfNeeded(connectionString: string): Promise<void> {
  if (!useEmbeddedPostgres) return;
  const embedded = await getEmbeddedPostgres();
  const oldDir = path.join(process.cwd(), ".pglite");
  const migratedDir = path.join(process.cwd(), ".pglite.migrated");
  if (!embedded.firstBoot || !existsSync(oldDir) || existsSync(migratedDir)) return;

  console.log("[db] Found legacy ./.pglite directory; attempting one-time migration to embedded PostgreSQL.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "migrate-from-pglite.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Legacy PGlite migration failed with exit code ${code}`));
    });
  });
}

async function runMigrations(): Promise<void> {
  const pool = globalForDb.__canolitePgPool;
  if (!pool) throw new Error("PostgreSQL pool was not initialized before migrations.");

  const { drizzle } = require("drizzle-orm/node-postgres");
  const { migrate } = require("drizzle-orm/node-postgres/migrator");
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    const lockedDb = drizzle(client, { schema });
    await migrate(lockedDb, { migrationsFolder: "./drizzle" });
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

export async function checkDatabaseHealth(): Promise<{
  ok: boolean;
  backend: "embedded" | "postgres";
  error?: string;
}> {
  try {
    await connectivityCheck();
    return { ok: true, backend: useEmbeddedPostgres ? "embedded" : "postgres" };
  } catch (error) {
    return {
      ok: false,
      backend: useEmbeddedPostgres ? "embedded" : "postgres",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Ensure the schema exists and demo data is present. Idempotent — safe to call
 * on every server boot. Runs migrations then seeds if empty.
 */
export async function ensureDb(): Promise<void> {
  if (globalForDb.__canoliteReady) return globalForDb.__canoliteReady;

  globalForDb.__canoliteReady = (async () => {
    assertDatabaseConfig();
    const connectionString = await prepareDatabaseUrl();

    console.log(
      useEmbeddedPostgres
        ? `[db] Backend selected: embedded PostgreSQL (${new URL(connectionString).host})`
        : `[db] Backend selected: external PostgreSQL (pool max ${dbPoolMax()})`
    );

    await connectivityCheck();
    console.log("[db] Connectivity check passed.");

    // Back up before applying any pending migration — never on every boot.
    // Failures must not block boot, so everything is logged and swallowed.
    try {
      const { hasPendingMigrations, createBackup } = require("../lib/backup");
      if (await hasPendingMigrations(db as any)) {
        await createBackup("pre-migration");
      }
    } catch (e) {
      console.warn(
        "[backup] Pre-migration backup skipped:",
        e instanceof Error ? e.message : e
      );
    }

    try {
      await runMigrations();
      console.log("[db] Migrations applied successfully.");
      await runLegacyPgliteMigrationIfNeeded(connectionString);
    } catch (error) {
      console.error("[db] Migration failed:", error);
      throw error;
    }

    const { seedIfEmpty, autoProvisionAdminFromEnv } = require("./seed-data");
    await seedIfEmpty(db);
    await autoProvisionAdminFromEnv(db);
  })().catch((error) => {
    globalForDb.__canoliteReady = undefined;
    throw error;
  });

  return globalForDb.__canoliteReady;
}
