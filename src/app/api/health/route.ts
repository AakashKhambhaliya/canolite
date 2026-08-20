import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { checkDatabaseHealth } from "@/db";

function getVersion(): string {
  // Prefer the version baked into the image at build time, so /api/health and
  // /api/update can never disagree about what is actually running.
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Commit SHA baked into the image at build time (GIT_SHA or SOURCE_COMMIT). */
function getCommit(): string {
  return (
    process.env.GIT_SHA || process.env.SOURCE_COMMIT || "unknown"
  );
}

/** Image build timestamp, written by the Dockerfile. */
function getBuildTime(): string {
  try {
    return fs
      .readFileSync(path.join(process.cwd(), ".build-time"), "utf-8")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Lightweight liveness probe for Docker / Coolify / Dokploy health checks.
 * Also reports the running version, commit, and build time so the updater UI
 * can confirm a redeploy landed. `status` and `version` are unchanged for
 * backwards compatibility (the Docker HEALTHCHECK keys off this endpoint).
 */
export async function GET() {
  const database = await checkDatabaseHealth();
  return NextResponse.json(
    {
      status: database.ok ? "ok" : "error",
      version: getVersion(),
      commit: getCommit(),
      buildTime: getBuildTime(),
      database,
    },
    { status: database.ok ? 200 : 503 }
  );
}
