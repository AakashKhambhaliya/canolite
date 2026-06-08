import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.projectId, user.projectId)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error revoking key:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
