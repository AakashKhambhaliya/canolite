import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { verifyApiKey, extractPrefix, hashApiKey, isLegacyApiKeyHash } from "@/lib/api-keys";

const LAST_USED_RESOLUTION_MS = 60_000;

export interface ApiAuthResult {
  projectId: string;
  keyId: string;
}

export async function authenticateApiKey(
  request: Request
): Promise<ApiAuthResult | NextResponse> {
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      {
        error: "Missing or invalid Authorization header",
        hint: "Use: Authorization: Bearer sk_live_...",
      },
      { status: 401 }
    );
  }

  const token = authHeader.substring(7);
  const prefix = extractPrefix(token);

  // Find keys by prefix
  const candidateKeys = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyPrefix, prefix), isNull(apiKeys.revokedAt)));

  for (const key of candidateKeys) {
    if (await verifyApiKey(token, key.keyHash)) {
      // Record use at most once a minute: writing the row on EVERY request
      // (including each private /storage fetch) was pure write contention.
      // A legacy bcrypt hash is upgraded to SHA-256 in the same write, so the
      // slow path runs once per old key, not once per request.
      const now = new Date();
      const stale =
        !key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS;
      const upgrade = isLegacyApiKeyHash(key.keyHash);
      if (stale || upgrade) {
        await db
          .update(apiKeys)
          .set({
            ...(stale ? { lastUsedAt: now } : {}),
            ...(upgrade ? { keyHash: hashApiKey(token) } : {}),
          })
          .where(eq(apiKeys.id, key.id))
          .catch((error) =>
            console.warn("[api-auth] Could not record key use:", error instanceof Error ? error.message : error)
          );
      }

      return {
        projectId: key.projectId,
        keyId: key.id,
      };
    }
  }

  return NextResponse.json(
    { error: "Invalid or revoked API key" },
    { status: 401 }
  );
}
