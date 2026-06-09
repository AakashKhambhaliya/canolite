import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { readStatus } from "@/lib/updater";

/** GET /api/update/status — current progress of an in-flight update. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json(readStatus());
}
