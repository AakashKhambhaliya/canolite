import { NextResponse } from "next/server";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

/**
 * List the custom fonts uploaded for the current project. The font family name
 * is derived from the uploaded file name (without extension).
 */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const rows = await db
      .select()
      .from(assets)
      .where(
        and(eq(assets.projectId, user.projectId), eq(assets.type, "font"))
      );

    const fonts = rows.map((a: any) => ({
      id: a.id,
      family: a.name.replace(/\.[^.]+$/, ""),
      url: a.url,
    }));

    return NextResponse.json({ fonts });
  } catch (error) {
    console.error("Error listing fonts:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
