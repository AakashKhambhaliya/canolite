import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs, templates } from "@/db/schema";
import { eq, and, desc, getTableColumns } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    // Filter by status in SQL (before LIMIT) so the latest 100 of that status
    // are returned — not just the statuses that happen to be in the latest 100.
    const where = status
      ? and(eq(renderJobs.projectId, user.projectId), eq(renderJobs.status, status))
      : eq(renderJobs.projectId, user.projectId);

    // The template is joined in for two reasons: the dashboard's search box
    // has always filtered on `templateName` (which the API never sent, so it
    // matched nothing), and the public `templateUid` is the key the render-time
    // statistics are grouped by, so a row can show a per-template estimate.
    const results = await db
      .select({
        ...getTableColumns(renderJobs),
        templateName: templates.name,
        templateUid: templates.templateId,
        templateWidth: templates.width,
        templateHeight: templates.height,
      })
      .from(renderJobs)
      .leftJoin(templates, eq(renderJobs.templateId, templates.id))
      .where(where)
      .orderBy(desc(renderJobs.createdAt))
      .limit(100);

    return NextResponse.json(results);
  } catch (error) {
    console.error("Error fetching renders:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
