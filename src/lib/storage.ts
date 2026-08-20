/**
 * Storage layer.
 *
 * Local-filesystem implementation: files are written under public/storage/<key>
 * and served statically by Next.js at ${APP_URL}/storage/<key>. This keeps the
 * app self-contained (no S3/MinIO needed). The exported surface matches the
 * original S3 helpers so callers are unchanged.
 */
import { promises as fs } from "fs";
import path from "path";

const STORAGE_ROOT =
  process.env.STORAGE_DIR || path.join(process.cwd(), "public", "storage");

function appUrl(): string {
  return process.env.APP_URL || "http://localhost:3000";
}

function pathForKey(key: string): string {
  // Prevent path traversal: the resolved path must stay within STORAGE_ROOT.
  const root = path.resolve(STORAGE_ROOT);
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return full;
}

export async function ensureBucket(): Promise<void> {
  await fs.mkdir(STORAGE_ROOT, { recursive: true });
}

/**
 * One-time migration from the legacy storage location to the configured
 * `STORAGE_DIR`. Only runs when `STORAGE_DIR` is set and points somewhere other
 * than the legacy `public/storage` — and only when the legacy directory is
 * non-empty while the target is empty (or absent). Idempotent: once the target
 * is populated it is never touched again, and fresh installs (empty legacy dir)
 * are skipped entirely.
 */
export async function migrateLegacyStorage(): Promise<void> {
  const storageDir = process.env.STORAGE_DIR;
  if (!storageDir) return; // default local-dev layout — nothing to migrate

  const legacyRoot = path.join(process.cwd(), "public", "storage");
  const targetRoot = path.resolve(storageDir);
  if (path.resolve(legacyRoot) === targetRoot) return;

  let legacyIsDir = false;
  try {
    legacyIsDir = (await fs.stat(legacyRoot)).isDirectory();
  } catch {
    return; // no legacy directory — fresh install
  }
  if (!legacyIsDir) return;

  const legacyEntries = await fs.readdir(legacyRoot);
  if (legacyEntries.length === 0) return; // nothing to move

  try {
    const targetEntries = await fs.readdir(targetRoot);
    if (targetEntries.length > 0) return; // target already populated
  } catch {
    // target doesn't exist yet — fine, we'll create it
  }

  console.log(
    `[storage] Migrating legacy storage ${legacyRoot} → ${targetRoot} ` +
      `(${legacyEntries.length} entries)`
  );
  await fs.cp(legacyRoot, targetRoot, { recursive: true });
  console.log("[storage] Legacy storage migration complete.");
}

/** Resolve a storage key to its absolute filesystem path (traversal-checked). */
export function storageFilePath(key: string): string {
  return pathForKey(key);
}

export async function uploadFile(
  key: string,
  body: Buffer | Uint8Array,
  _contentType: string
): Promise<string> {
  const filePath = pathForKey(key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body);
  return getFileUrl(key);
}

export async function deleteFile(key: string): Promise<void> {
  try {
    await fs.unlink(pathForKey(key));
  } catch {
    // Ignore missing files.
  }
}

/**
 * Stored files are referenced by a ROOT-RELATIVE URL (`/storage/<key>`) so they
 * resolve against whatever host/port the app is actually served on — this avoids
 * broken images when APP_URL is unset or doesn't match the running port.
 */
export function getFileUrl(key: string): string {
  return `/storage/${key}`;
}

/** Turn a relative storage URL into an absolute one using APP_URL. Used where
 *  there's no request context (e.g. webhook delivery to external systems). */
export function toAbsoluteUrl(url: string | null | undefined): string {
  if (!url) return url || "";
  if (/^https?:\/\//i.test(url)) return url; // already absolute
  const base = appUrl().replace(/\/$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** Derive the request's origin dynamically (matches whatever host/proto the
 *  client used, including behind a reverse proxy). Falls back to APP_URL. */
export function requestBaseUrl(req: Request): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (!host) return appUrl().replace(/\/$/, "");
  const proto =
    req.headers.get("x-forwarded-proto") ||
    (/^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/** Make a stored (relative) URL absolute against the request's own origin. */
export function absoluteForRequest(
  req: Request,
  url: string | null | undefined
): string {
  if (!url) return url || "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${requestBaseUrl(req)}${url.startsWith("/") ? "" : "/"}${url}`;
}

export { appUrl };
