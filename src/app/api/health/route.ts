import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Lightweight liveness probe for Docker / Coolify / Dokploy health checks.
 *  Also reports the running version so the updater UI can confirm a restart. */
export async function GET() {
  return NextResponse.json({ status: "ok", version: getVersion() });
}
