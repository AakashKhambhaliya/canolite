import bcrypt from "bcryptjs";
import { generateToken } from "./utils";

const KEY_PREFIX = "sk_live_";

export function generateApiKey(): {
  fullKey: string;
  prefix: string;
  hash: string;
} {
  const randomPart = generateToken(32);
  const fullKey = `${KEY_PREFIX}${randomPart}`;
  const prefix = fullKey.substring(0, 12);
  const hash = bcrypt.hashSync(fullKey, 10);

  return { fullKey, prefix, hash };
}

/**
 * Async on purpose: bcrypt at cost 10 takes ~60-100ms, and `compareSync` spends
 * all of it blocking the event loop — on every single public API request, where
 * it stalls every other in-flight render and response. `compare` hands the work
 * to the thread pool instead.
 */
export function verifyApiKey(
  presentedKey: string,
  storedHash: string
): Promise<boolean> {
  return bcrypt.compare(presentedKey, storedHash);
}

export function extractPrefix(key: string): string {
  return key.substring(0, 12);
}
