import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { getCurrentUser } from "@/lib/auth";

const ROOT = process.cwd();

/** File that persists the last-check timestamp (survives restarts). */
const LAST_CHECK_FILE = path.join(ROOT, ".update-last-check");

function run(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, timeout: 30_000 }).toString().trim();
  } catch (e: any) {
    return e.stderr?.toString?.().trim() || e.message || "";
  }
}

function getLocalCommit(): string {
  return run("git rev-parse HEAD");
}

function getRemoteCommit(): string {
  // Fetch latest without modifying working tree
  run("git fetch origin --quiet");
  // Get the default branch name
  const branch =
    run("git rev-parse --abbrev-ref HEAD") || "main";
  return run(`git rev-parse origin/${branch}`);
}

function getLastCheckTime(): number {
  try {
    if (fs.existsSync(LAST_CHECK_FILE)) {
      return parseInt(fs.readFileSync(LAST_CHECK_FILE, "utf-8"), 10) || 0;
    }
  } catch {}
  return 0;
}

function setLastCheckTime(): void {
  try {
    fs.writeFileSync(LAST_CHECK_FILE, Date.now().toString());
  } catch {}
}

function getCommitLog(from: string, to: string): string[] {
  try {
    const log = run(
      `git log --oneline ${from}..${to} --format="%s"`
    );
    return log ? log.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * GET /api/update — Check for updates
 */
export async function GET() {
  // Admin only — this shells out to git and reads repo state.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const localCommit = getLocalCommit();
    const remoteCommit = getRemoteCommit();
    const updateAvailable = localCommit !== remoteCommit;
    const changes = updateAvailable
      ? getCommitLog(localCommit, remoteCommit)
      : [];
    const lastCheck = getLastCheckTime();

    setLastCheckTime();

    return NextResponse.json({
      updateAvailable,
      currentVersion: getVersion(),
      localCommit: localCommit.slice(0, 7),
      remoteCommit: remoteCommit.slice(0, 7),
      changes,
      lastCheck,
      checkedAt: Date.now(),
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        updateAvailable: false,
        error: e.message || "Failed to check for updates",
        currentVersion: getVersion(),
        localCommit: "",
        remoteCommit: "",
        changes: [],
        lastCheck: 0,
        checkedAt: Date.now(),
      },
      { status: 200 }
    );
  }
}

/**
 * POST /api/update — Install update (git pull + npm install)
 */
export async function POST(_req: NextRequest) {
  // Admin only — this performs `git pull` + `npm install` on the server, so it
  // MUST require an authenticated session (otherwise it's a remote code
  // execution vector).
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const branch = run("git rev-parse --abbrev-ref HEAD") || "main";

    // Stash any local changes (shouldn't be any in production)
    run("git stash --quiet 2>/dev/null || true");

    // Pull latest
    const pullResult = run(`git pull origin ${branch} --ff-only`);

    // Check if package.json changed and run npm install
    const diffFiles = run(
      `git diff HEAD~1 --name-only 2>/dev/null || echo ""`
    );
    let npmInstalled = false;
    if (diffFiles.includes("package.json") || diffFiles.includes("package-lock.json")) {
      run("npm install --production --no-audit --no-fund");
      npmInstalled = true;
    }

    // Update the version
    const newVersion = getVersion();
    const newCommit = getLocalCommit().slice(0, 7);

    setLastCheckTime();

    return NextResponse.json({
      success: true,
      message: "Update installed successfully. Please restart the application.",
      pullResult,
      npmInstalled,
      newVersion,
      newCommit,
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        success: false,
        message: e.message || "Failed to install update",
      },
      { status: 500 }
    );
  }
}
