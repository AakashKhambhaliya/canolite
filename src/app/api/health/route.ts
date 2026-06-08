import { NextResponse } from "next/server";

/** Lightweight liveness probe for Docker / Coolify / Dokploy health checks. */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
