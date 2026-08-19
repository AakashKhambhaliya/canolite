/**
 * Automatic database backups.
 *
 * A backup is written to `/app/data/backups/<reason>-<version>-<ISO timestamp>/`
 * whenever a migration is about to be applied (so a bad migration can always be
 * rolled back). Backups never block or crash boot: every failure is logged and
 * swallowed by the caller.
 *
 * - PGlite: uses the PGlite `dumpDataDir("gzip")` API — a restorable tarball of
 *   the database's data directory.
 * - PostgreSQL: shells out to `pg_dump` (custom format); if it isn't installed
 *   the backup is skipped with a clear warning.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { sql } from "drizzle-orm";

// Default is the persistent volume's backups dir in Docker. Overridable so the
// bare-VPS / git-checkout path (no /app/data) can back up somewhere sensible,
// and for testing.
const BACKUP_ROOT = process.env.BACKUP_DIR || "/app/data/backups";
const MAX_BACKUPS = 5;

function getAppVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Highest migration `when` timestamp in the drizzle journal (0 if unknown). */
function readJournalMaxWhen(): number {
  try {
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "drizzle", "meta", "_journal.json"),
        "utf-8"
      )
    );
    const entries: { when?: number }[] = journal?.entries || [];
    return entries.reduce((m, e) => Math.max(m, e.when || 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Max `created_at` in the drizzle migration table, or `null` when the table
 * doesn't exist yet (a brand-new, never-migrated database).
 */
async function getAppliedMaxCreatedAt(db: any): Promise<number | null> {
  try {
    const res: any = await db.execute(
      sql`select max(created_at) as m from drizzle.__drizzle_migrations`
    );
    const rows: any[] = Array.isArray(res) ? res : res?.rows || [];
    const m = rows[0]?.m;
    return m == null ? 0 : Number(m);
  } catch {
    return null; // table/schema absent → fresh DB
  }
}

/** True when the journal contains a migration newer than what's been applied. */
export async function hasPendingMigrations(db: any): Promise<boolean> {
  const journalMax = readJournalMaxWhen();
  if (journalMax <= 0) return false;
  const applied = await getAppliedMaxCreatedAt(db);
  if (applied === null) return false; // fresh DB — nothing to protect
  return applied < journalMax;
}

/** Run pg_dump (custom format) into `outFile`. Returns false if unavailable. */
async function pgDumpIfAvailable(
  databaseUrl: string,
  outFile: string
): Promise<boolean> {
  const probe = spawn("pg_dump", ["--version"], { stdio: "ignore" });
  const available = await new Promise<boolean>((resolve) => {
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
  if (!available) return false;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pg_dump",
      ["--dbname", databaseUrl, "--format=custom", "--file", outFile],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let err = "";
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error((err || `pg_dump exited ${code}`).trim()));
    });
  });
  return true;
}

/** Keep only the MAX_BACKUPS most recent backup directories. */
async function pruneBackups(): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(BACKUP_ROOT);
  } catch {
    return; // no backups dir
  }

  const dirs: { name: string; full: string; mtime: number }[] = [];
  for (const name of names) {
    const full = path.join(BACKUP_ROOT, name);
    try {
      const st = await fs.promises.stat(full);
      if (st.isDirectory()) dirs.push({ name, full, mtime: st.mtimeMs });
    } catch {
      // ignore unreadable entries
    }
  }

  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const d of dirs.slice(MAX_BACKUPS)) {
    await fs.promises.rm(d.full, { recursive: true, force: true }).catch(() => {});
    console.log(`[backup] Pruned old backup: ${d.name}`);
  }
}

/**
 * Create a backup and return its directory path. Returns "" when the backup was
 * skipped (e.g. pg_dump unavailable on a Postgres install) — never throws for
 * that case. Throws only on real I/O failures, which the caller must swallow.
 */
export async function createBackup(reason: string): Promise<string> {
  // Lazy import to avoid a load-time cycle with src/db (which calls us).
  const { db, usePglite } = await import("../db");

  const version = getAppVersion();
  const dir = path.join(BACKUP_ROOT, `${reason}-${version}-${backupStamp()}`);
  await fs.promises.mkdir(dir, { recursive: true });

  if (usePglite) {
    const client = (db as any)?.$client;
    if (!client || typeof client.dumpDataDir !== "function") {
      throw new Error("PGlite client does not expose dumpDataDir()");
    }
    const blob: Blob = await client.dumpDataDir("gzip");
    const buf = Buffer.from(await blob.arrayBuffer());
    await fs.promises.writeFile(path.join(dir, "database.tar.gz"), buf);
  } else {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("No DATABASE_URL set for a PostgreSQL backup");
    }
    const ok = await pgDumpIfAvailable(databaseUrl, path.join(dir, "database.dump"));
    if (!ok) {
      console.warn(
        "[backup] pg_dump is not available — skipping the database backup. " +
          "Install postgresql-client in the image to enable Postgres backups."
      );
      await fs.promises.rmdir(dir).catch(() => {});
      return "";
    }
  }

  await fs.promises.writeFile(
    path.join(dir, "backup.json"),
    JSON.stringify(
      {
        reason,
        version,
        createdAt: new Date().toISOString(),
        mode: usePglite ? "pglite" : "postgres",
      },
      null,
      2
    )
  );

  await pruneBackups();
  console.log(`[backup] Created backup: ${dir}`);
  return dir;
}
