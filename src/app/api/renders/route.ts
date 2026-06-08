import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = db
      .select()
      .from(renderJobs)
      .where(eq(renderJobs.projectId, user.projectId))
      .orderBy(desc(renderJobs.createdAt))
      .limit(100);

    const results = await query;

    // Filter by status if provided
    const filtered = status
      ? results.filter((r) => r.status === status)
      : results;

    return NextResponse.json(filtered);
  } catch (error) {
    console.error("Error fetching renders:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
