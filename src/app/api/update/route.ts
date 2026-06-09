import { NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { getCurrentUser } from "@/lib/auth";
import { startUpdate, isGitCheckout } from "@/lib/updater";

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

  // Image-based deploys (Docker/Coolify) have no git checkout, so we can't —
  // and shouldn't — self-update. Report "up to date" instead of letting two
  // failing `git rev-parse` calls return different error strings and look like
  // an available update. These instances update by pulling a new image.
  if (!isGitCheckout()) {
    return NextResponse.json({
      updateAvailable: false,
      canSelfUpdate: false,
      currentVersion: getVersion(),
      localCommit: "",
      remoteCommit: "",
      changes: [],
      lastCheck: getLastCheckTime(),
      checkedAt: Date.now(),
    });
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
      // Whether the in-app updater can apply this (a git checkout). Pure Docker
      // image deploys must update by pulling a new image instead.
      canSelfUpdate: isGitCheckout(),
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
 * POST /api/update — Install update (git pull → npm install → build → restart)
 *
 * The actual work runs in the background (see lib/updater). This handler just
 * kicks it off and returns immediately; the client polls GET /api/update/status
 * and reloads once the rebuilt server comes back up.
 */
export async function POST() {
  // Admin only — this performs `git pull` + `npm install` + `npm run build` on
  // the server, so it MUST require an authenticated session (otherwise it's a
  // remote code execution vector).
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { started, reason } = startUpdate();

  if (!started) {
    if (reason === "not-a-git-checkout") {
      return NextResponse.json(
        {
          success: false,
          restarting: false,
          message:
            "This deployment can't update itself in-app (no git checkout). " +
            "Update by pulling the new Docker image: re-run install.sh or " +
            "`docker compose pull && docker compose up -d`.",
        },
        { status: 200 }
      );
    }
    // already-running
    return NextResponse.json({
      success: true,
      restarting: true,
      message: "An update is already in progress.",
    });
  }

  return NextResponse.json({
    success: true,
    restarting: true,
    message:
      "Update started — the app will rebuild and restart automatically. " +
      "Please don't close this tab.",
  });
}
