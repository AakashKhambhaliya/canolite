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

export function verifyApiKey(
  presentedKey: string,
  storedHash: string
): boolean {
  return bcrypt.compareSync(presentedKey, storedHash);
}

export function extractPrefix(key: string): string {
  return key.substring(0, 12);
}
