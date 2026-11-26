import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import pg from "pg";

const DEFAULT_PORT = 54329;
const DB_NAME = "canolite";
const CREDENTIALS_VERSION = 1;

interface EmbeddedCredentials {
  version: number;
  user: string;
  password: string;
  database: string;
  port: number;
}

interface EmbeddedRuntime {
  connectionString: string;
  dataDir: string;
  port: number;
  stop: () => Promise<void>;
  ownsProcess: boolean;
  firstBoot: boolean;
}

const globalForEmbedded = globalThis as unknown as {
  __canoliteEmbeddedPg?: EmbeddedRuntime;
  __canoliteEmbeddedPgPromise?: Promise<EmbeddedRuntime>;
  __canoliteEmbeddedShutdownInstalled?: boolean;
  __canoliteEmbeddedStopPromise?: Promise<void>;
};

function dataDir(): string {
  return path.resolve(process.env.PGDATA_DIR || path.join(process.cwd(), "data", "pgdata"));
}

function port(): number {
  const parsed = Number(process.env.PGPORT || DEFAULT_PORT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_PORT;
}

function credentialsPath(dir: string): string {
  return path.join(path.dirname(dir), "pg-credentials.json");
}

function connectionString(creds: EmbeddedCredentials): string {
  const user = encodeURIComponent(creds.user);
  const password = encodeURIComponent(creds.password);
  return `postgres://${user}:${password}@127.0.0.1:${creds.port}/${creds.database}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isInitialized(dir: string): Promise<boolean> {
  return exists(path.join(dir, "PG_VERSION"));
}

async function readCredentials(file: string): Promise<EmbeddedCredentials> {
  const raw = await fs.readFile(file, "utf8");
  try {
    return JSON.parse(raw) as EmbeddedCredentials;
  } catch (error) {
    // Never "repair" this by generating a new password: an initialised pgdata
    // only accepts the original one, so that would lock the app out for good.
    throw new Error(
      `Embedded PostgreSQL credentials file ${file} is unreadable (${error instanceof Error ? error.message : String(error)}). ` +
        "Restore it from a backup; it must hold the password the data directory was initialised with."
    );
  }
}

async function readOrCreateCredentials(dir: string): Promise<EmbeddedCredentials> {
  const file = credentialsPath(dir);
  try {
    return await readCredentials(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  // Missing file. Only a fresh (uninitialised) data dir may get new
  // credentials; an initialised one would reject them.
  if (await isInitialized(dir)) {
    throw new Error(
      `Embedded PostgreSQL credentials file ${file} is missing but ${dir} is already initialised. ` +
        "Restore pg-credentials.json from a backup, or move the data directory aside to start fresh."
    );
  }

  const creds: EmbeddedCredentials = {
    version: CREDENTIALS_VERSION,
    user: "canolite",
    password: crypto.randomBytes(24).toString("base64url"),
    database: DB_NAME,
    port: port(),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    // "wx": create exclusively, so two processes booting together can't each
    // write a different password — the loser reads the winner's file.
    await fs.writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600, flag: "wx" });
    return creds;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return readCredentials(file);
    throw error;
  }
}

function assertSupportedRuntime(): void {
  const report = process.report?.getReport?.() as any;
  if (process.platform === "linux" && !report?.header?.glibcVersionRuntime) {
    throw new Error(
      "Embedded PostgreSQL requires a glibc-based Linux image. Alpine/musl images " +
        "are not supported by the embedded-postgres binaries. Use the provided " +
        "Debian-based Dockerfile, or set DATABASE_URL to an external postgres:// " +
        "database."
    );
  }

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error(
      "Embedded PostgreSQL cannot run as root. Postgres refuses to start as the " +
        "root user. Fix this by running the app as a non-root user in the " +
        "Dockerfile (for example USER canolite), or set DATABASE_URL to an " +
        "external postgres:// database."
    );
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process EXISTS but belongs to another user — it is
    // alive, and its postmaster.pid must not be deleted.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function readPostmasterPid(dir: string): Promise<number | null> {
  try {
    const firstLine = (await fs.readFile(path.join(dir, "postmaster.pid"), "utf8")).split(/\r?\n/)[0];
    const pid = Number(firstLine);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitForConnection(creds: EmbeddedCredentials, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: "127.0.0.1",
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: "postgres",
    });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError || "timeout");
  throw new Error(`Embedded PostgreSQL did not become reachable on 127.0.0.1:${creds.port}: ${msg}`);
}

async function ensureDatabase(creds: EmbeddedCredentials): Promise<void> {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database: "postgres",
  });
  await client.connect();
  try {
    const found = await client.query("select 1 from pg_database where datname = $1", [creds.database]);
    if (found.rowCount === 0) {
      await client.query(`create database ${client.escapeIdentifier(creds.database)}`);
    }
  } finally {
    await client.end();
  }
}

async function startRuntime(): Promise<EmbeddedRuntime> {
  assertSupportedRuntime();
  const dir = dataDir();
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const firstBoot = !(await isInitialized(dir));
  const creds = await readOrCreateCredentials(dir);
  creds.port = port();

  const EmbeddedPostgres = (await import("embedded-postgres")).default;
  const pgInstance = new EmbeddedPostgres({
    databaseDir: dir,
    user: creds.user,
    password: creds.password,
    port: creds.port,
    persistent: true,
    authMethod: "password",
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: (message: unknown) => {
      const text = String(message).trim();
      if (text) console.log(`[embedded-postgres] ${text}`);
    },
    onError: (message: unknown) => {
      const text = message instanceof Error ? message.message : String(message).trim();
      if (text) console.error(`[embedded-postgres] ${text}`);
    },
  });

  if (!(await isInitialized(dir))) {
    await pgInstance.initialise();
  }

  const pid = await readPostmasterPid(dir);
  if (pid && pidIsAlive(pid)) {
    await waitForConnection(creds);
    await ensureDatabase(creds);
    return {
      connectionString: connectionString(creds),
      dataDir: dir,
      port: creds.port,
      ownsProcess: false,
      firstBoot,
      stop: async () => undefined,
    };
  }

  if (pid) {
    await fs.rm(path.join(dir, "postmaster.pid"), { force: true });
  }

  await pgInstance.start();
  await waitForConnection(creds);
  await ensureDatabase(creds);

  return {
    connectionString: connectionString(creds),
    dataDir: dir,
    port: creds.port,
    ownsProcess: true,
    firstBoot,
    stop: async () => {
      await pgInstance.stop();
    },
  };
}

function installShutdownHandlers(): void {
  if (globalForEmbedded.__canoliteEmbeddedShutdownInstalled) return;
  globalForEmbedded.__canoliteEmbeddedShutdownInstalled = true;

  // SIGTERM/SIGINT are NOT handled here: src/db/index.ts owns signal-driven
  // shutdown so it can drain the pool BEFORE Postgres stops (stopping it here
  // too raced that drain). beforeExit covers a natural, signal-free exit.
  process.once("beforeExit", () => {
    stopEmbeddedPostgres().catch((error) =>
      console.error("[db] Error stopping embedded PostgreSQL:", error)
    );
  });
}

/** Stop the embedded server. Concurrent callers share one in-flight stop. */
export function stopEmbeddedPostgres(): Promise<void> {
  if (globalForEmbedded.__canoliteEmbeddedStopPromise) {
    return globalForEmbedded.__canoliteEmbeddedStopPromise;
  }
  const runtime = globalForEmbedded.__canoliteEmbeddedPg;
  globalForEmbedded.__canoliteEmbeddedPg = undefined;
  if (!runtime?.ownsProcess) return Promise.resolve();
  console.log("[db] Stopping embedded PostgreSQL.");
  const stopping = runtime.stop().finally(() => {
    globalForEmbedded.__canoliteEmbeddedStopPromise = undefined;
  });
  globalForEmbedded.__canoliteEmbeddedStopPromise = stopping;
  return stopping;
}

export async function getEmbeddedPostgres(): Promise<EmbeddedRuntime> {
  if (globalForEmbedded.__canoliteEmbeddedPg) return globalForEmbedded.__canoliteEmbeddedPg;
  if (!globalForEmbedded.__canoliteEmbeddedPgPromise) {
    globalForEmbedded.__canoliteEmbeddedPgPromise = startRuntime()
      .then((runtime) => {
        globalForEmbedded.__canoliteEmbeddedPg = runtime;
        installShutdownHandlers();
        return runtime;
      })
      .finally(() => {
        globalForEmbedded.__canoliteEmbeddedPgPromise = undefined;
      });
  }
  return globalForEmbedded.__canoliteEmbeddedPgPromise;
}
