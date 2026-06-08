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

const STORAGE_ROOT = path.join(process.cwd(), "public", "storage");
const BUCKET = process.env.S3_BUCKET || "canolite";

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

export async function getPresignedUploadUrl(
  key: string,
  _contentType: string,
  _expiresIn: number = 3600
): Promise<string> {
  // No signing needed for local storage — uploads go through /api/upload.
  return getFileUrl(key);
}

export async function getPresignedDownloadUrl(
  key: string,
  _expiresIn: number = 3600
): Promise<string> {
  return getFileUrl(key);
}

export async function deleteFile(key: string): Promise<void> {
  try {
    await fs.unlink(pathForKey(key));
  } catch {
    // Ignore missing files.
  }
}

export function getFileUrl(key: string): string {
  return `${appUrl()}/storage/${key}`;
}

export { BUCKET };
