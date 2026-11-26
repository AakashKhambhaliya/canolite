import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "crypto";
import { generateToken } from "./utils";

const KEY_PREFIX = "sk_live_";
const SHA256_TAG = "sha256:";

/**
 * API keys are 32 random characters — high-entropy secrets, not passwords —
 * so a fast hash is the right tool: there is nothing for a slow KDF to
 * protect against, and bcrypt cost 10 put ~60-100ms of pure-JS hashing on the
 * event loop for EVERY public API request. The gap between a prefix miss
 * (no hash at all) and a hit (one bcrypt) was also a timing oracle for which
 * 4-character key prefixes exist. SHA-256 + a constant-time compare removes
 * both. Keys created before this change keep their bcrypt hash and still
 * verify; `isLegacyApiKeyHash` lets the caller upgrade them on first use.
 */
function sha256Hash(key: string): string {
  return SHA256_TAG + createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): {
  fullKey: string;
  prefix: string;
  hash: string;
} {
  const randomPart = generateToken(32);
  const fullKey = `${KEY_PREFIX}${randomPart}`;
  const prefix = fullKey.substring(0, 12);
  const hash = sha256Hash(fullKey);

  return { fullKey, prefix, hash };
}

/** True for a hash written before keys moved to SHA-256. */
export function isLegacyApiKeyHash(storedHash: string): boolean {
  return !storedHash.startsWith(SHA256_TAG);
}

/** The current-format hash for a key (used to upgrade a legacy hash). */
export function hashApiKey(key: string): string {
  return sha256Hash(key);
}

export async function verifyApiKey(
  presentedKey: string,
  storedHash: string
): Promise<boolean> {
  if (!isLegacyApiKeyHash(storedHash)) {
    const expected = Buffer.from(storedHash, "utf8");
    const actual = Buffer.from(sha256Hash(presentedKey), "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  // Legacy bcrypt hash. Async so the work isn't one long synchronous block.
  return bcrypt.compare(presentedKey, storedHash);
}

export function extractPrefix(key: string): string {
  return key.substring(0, 12);
}
