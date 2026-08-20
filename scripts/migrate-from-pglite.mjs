#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import pg from "pg";

const root = process.cwd();
const oldDir = path.join(root, ".pglite");
const migratedDir = path.join(root, ".pglite.migrated");

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadPglite() {
  try {
    const mod = await import("@electric-sql/pglite");
    return mod.PGlite;
  } catch (error) {
    throw new Error(
      "Cannot migrate ./.pglite because @electric-sql/pglite is not installed. " +
        "Run this migration before removing the old dependency, or restore the " +
        "old package temporarily and re-run scripts/migrate-from-pglite.mjs. " +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function main() {
  if (!(await exists(oldDir))) {
    console.log("[pglite-migrate] No ./.pglite directory found; nothing to migrate.");
    return;
  }
  if (await exists(migratedDir)) {
    console.log("[pglite-migrate] ./.pglite.migrated already exists; skipping.");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL || `postgres://canolite:canolite@127.0.0.1:${process.env.PGPORT || 54329}/canolite`;
  const PGlite = await loadPglite();
  const source = new PGlite(oldDir);
  const target = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await target.connect();

  try {
    const tableResult = await source.query(`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `);
    const tables = tableResult.rows.map((r) => r.table_name);
    console.log(`[pglite-migrate] Migrating ${tables.length} table(s) from ./.pglite.`);

    await target.query("begin");
    await target.query("set session_replication_role = replica").catch(() => undefined);

    for (const table of tables) {
      const rowsResult = await source.query(`select * from ${quoteIdent(table)}`);
      const rows = rowsResult.rows || [];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      const columnSql = columns.map(quoteIdent).join(", ");
      const valueSql = columns.map((_, i) => `$${i + 1}`).join(", ");
      const insertSql = `insert into ${quoteIdent(table)} (${columnSql}) values (${valueSql}) on conflict do nothing`;
      for (const row of rows) {
        await target.query(insertSql, columns.map((c) => row[c]));
      }
      console.log(`[pglite-migrate] ${table}: ${rows.length} row(s)`);
    }

    await target.query("set session_replication_role = origin").catch(() => undefined);
    await target.query("commit");
    await fs.rename(oldDir, migratedDir);
    console.log("[pglite-migrate] Migration complete. Renamed ./.pglite to ./.pglite.migrated.");
  } catch (error) {
    await target.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await target.end().catch(() => undefined);
    await source.close?.().catch?.(() => undefined);
  }
}

main().catch((error) => {
  console.error("[pglite-migrate] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
