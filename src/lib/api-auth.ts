import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { verifyApiKey, extractPrefix } from "@/lib/api-keys";

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
    if (verifyApiKey(token, key.keyHash)) {
      // Update last used
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, key.id));

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
