import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateApiKey } from "@/lib/api-keys";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const keys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.projectId, user.projectId))
      .orderBy(desc(apiKeys.createdAt));

    return NextResponse.json(keys);
  } catch (error) {
    console.error("Error fetching keys:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { name } = await request.json();

    if (!name?.trim()) {
      return NextResponse.json(
        { error: "Key name is required" },
        { status: 400 }
      );
    }

    const { fullKey, prefix, hash } = generateApiKey();

    await db.insert(apiKeys).values({
      projectId: user.projectId,
      name: name.trim(),
      keyHash: hash,
      keyPrefix: prefix,
    });

    return NextResponse.json({ fullKey, prefix }, { status: 201 });
  } catch (error) {
    console.error("Error creating key:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
