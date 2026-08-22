import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { v4 as uuidv4 } from "uuid";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(prefix: string = ""): string {
  const raw = uuidv4().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${raw}` : raw;
}

const TOKEN_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Random token for session cookies and API keys.
 *
 * Rejection sampling, not `byte % 62`. 256 isn't a multiple of 62, so the
 * modulo mapping hands the first 8 letters of the alphabet five byte values
 * each while the other 54 get four — a ~25% bias on every character, which
 * shaves real entropy off a value whose whole job is to be unguessable.
 * Discarding the 8 bytes in the ragged tail (>= 248) makes the distribution
 * exactly uniform, at the cost of re-drawing ~3% of the time.
 */
export function generateToken(length: number = 48): string {
  const limit = 256 - (256 % TOKEN_CHARS.length); // 248
  // getRandomValues refuses buffers over 65536 bytes, so cap each draw well
  // under that. Every real caller asks for 32 or 48 characters and gets a
  // single pass; the cap only matters for outsized requests.
  const MAX_DRAW = 4096;
  let result = "";
  while (result.length < length) {
    // Over-draw a little so the common case still needs just one call after a
    // few rejections.
    const want = Math.min(MAX_DRAW, length - result.length + 8);
    const array = new Uint8Array(want);
    crypto.getRandomValues(array);
    for (const byte of array) {
      if (byte >= limit) continue;
      result += TOKEN_CHARS[byte % TOKEN_CHARS.length];
      if (result.length === length) break;
    }
  }
  return result;
}

export function formatDate(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatRelativeTime(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDate(date);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + "…";
}

export function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.resolve();
}
