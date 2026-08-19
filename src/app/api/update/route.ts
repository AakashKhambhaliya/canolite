import { NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import { getCurrentUser } from "@/lib/auth";
import {
  startUpdate,
  startCoolifyUpdate,
  isGitCheckout,
  isUpdateInFlight,
  updateMode,
} from "@/lib/updater";
import { persistentDataStatus } from "@/lib/persistence";

const ROOT = process.cwd();

/** State lives on the persistent volume when mounted (see lib/updater). */
const STATE_DIR = fs.existsSync("/app/data") ? "/app/data" : ROOT;

/** File that persists the last-check timestamp/result (survives restarts). */
const LAST_CHECK_FILE = path.join(STATE_DIR, ".update-last-check");

const GITHUB_RELEASES =
  "https://api.github.com/repos/AakashKhambhaliya/canolite/releases/latest";
const CHECK_TTL = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Run a git command off the event loop. Returns null when the command fails
 * (non-zero exit, git missing, timeout) so callers can tell "no answer" apart
 * from a real result — the previous version returned stderr as though it were
 * output, which made a failed fetch look like a different commit. It also ran
 * synchronously, so every dashboard load blocked the server on a network fetch.
 */
function run(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: ROOT, timeout: 30_000 }, (err, stdout) =>
      resolve(err ? null : stdout.toString().trim())
    );
  });
}

/** A resolved commit is always a full 40-char SHA; anything else is an error. */
const SHA_RE = /^[0-9a-f]{40}$/i;

async function getLocalCommit(): Promise<string | null> {
  const out = await run(["rev-parse", "HEAD"]);
  return out && SHA_RE.test(out) ? out : null;
}

async function getRemoteCommit(): Promise<string | null> {
  // Fetch latest without modifying the working tree. A failed fetch isn't fatal
  // on its own — origin/<branch> may still resolve from an earlier fetch.
  await run(["fetch", "origin", "--quiet"]);
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])) || "main";
  const out = await run(["rev-parse", `origin/${branch}`]);
  return out && SHA_RE.test(out) ? out : null;
}

interface LastCheck {
  timestamp: number;
  latestVersion: string | null;
}

function getLastCheck(): LastCheck {
  try {
    if (fs.existsSync(LAST_CHECK_FILE)) {
      const raw = fs.readFileSync(LAST_CHECK_FILE, "utf-8");
      const n = parseInt(raw, 10);
      if (!isNaN(n)) return { timestamp: n, latestVersion: null };
      return JSON.parse(raw);
    }
  } catch {}
  return { timestamp: 0, latestVersion: null };
}

function setLastCheck(lc: LastCheck): void {
  try {
    fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify(lc));
  } catch {}
}

async function getCommitLog(from: string, to: string): Promise<string[]> {
  const log = await run(["log", "--format=%s", `${from}..${to}`]);
  return log ? log.split("\n").filter(Boolean) : [];
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

/** Minimal semver parsing/comparison — never reports an update when the
 *  versions can't be parsed (avoids false positives from pre-release tags). */
function parseVersion(v: string): number[] | null {
  // Anchored at both ends on purpose: "1.6.0-rc.1" must NOT parse as 1.6.0,
  // or a pre-release would be advertised as a stable update — which is exactly
  // what the doc comment above promises does not happen.
  const m = String(v)
    .replace(/^v/i, "")
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * Latest release tag on GitHub, cached for 12h. Returns "unknown" (null version)
 * on rate limiting or network failure — never a false positive. A failed check
 * is NOT cached, so a later check retries.
 */
async function getLatestReleaseVersion(force = false): Promise<{
  version: string | null;
  status: "ok" | "unknown";
}> {
  const last = getLastCheck();
  // Only a cached entry that actually holds a version counts as a hit. An older
  // build (and the git path) wrote a timestamp with latestVersion null, which
  // was then served for 12h as a confident "you are up to date".
  if (
    !force &&
    last.latestVersion &&
    last.timestamp > 0 &&
    Date.now() - last.timestamp < CHECK_TTL
  ) {
    return { version: last.latestVersion, status: "ok" };
  }

  try {
    const res = await fetch(GITHUB_RELEASES, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "canolite-updater",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // 403/429 = rate limited, 5xx = GitHub down — treat as unknown.
      return { version: null, status: "unknown" };
    }
    const data = await res.json();
    const version = data?.tag_name || null;
    setLastCheck({ timestamp: Date.now(), latestVersion: version });
    return { version, status: "ok" };
  } catch {
    return { version: null, status: "unknown" };
  }
}

/**
 * GET /api/update — Check for updates
 */
export async function GET(request: Request) {
  // Admin only — this shells out to git and reads repo state.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const mode = updateMode();
  // A manual "check now" sends force=1 so a freshly published release appears
  // immediately; the automatic 24h check honours the cache (GitHub rate limits).
  const force = new URL(request.url).searchParams.get("force") === "1";

  // Image-based deploys (Coolify / Docker) have no git checkout: compare the
  // running version against the latest GitHub release instead.
  if (mode !== "git") {
    const currentVersion = process.env.APP_VERSION || getVersion();
    const { version: latest, status } = await getLatestReleaseVersion(force);
    const updateAvailable = latest ? isNewer(latest, currentVersion) : false;

    return NextResponse.json({
      updateAvailable,
      canSelfUpdate: false,
      currentVersion,
      localCommit: process.env.GIT_SHA || "",
      remoteCommit: "",
      changes: [],
      lastCheck: getLastCheck().timestamp,
      checkedAt: Date.now(),
      mode,
      latestVersion: latest || null,
      checkStatus: status,
    });
  }

  try {
    const prev = getLastCheck();
    const localCommit = await getLocalCommit();
    const remoteCommit = await getRemoteCommit();

    // Couldn't resolve both sides (offline, no origin remote, detached HEAD) —
    // report that, instead of reading the failure as "a new commit is waiting".
    if (!localCommit || !remoteCommit) {
      return NextResponse.json({
        updateAvailable: false,
        currentVersion: getVersion(),
        localCommit: localCommit ? localCommit.slice(0, 7) : "",
        remoteCommit: "",
        changes: [],
        lastCheck: prev.timestamp,
        checkedAt: Date.now(),
        canSelfUpdate: isGitCheckout(),
        mode,
        checkStatus: "unknown",
      });
    }

    const updateAvailable = localCommit !== remoteCommit;
    const changes = updateAvailable
      ? await getCommitLog(localCommit, remoteCommit)
      : [];

    // Preserve any cached release version — this path never looks one up.
    setLastCheck({ timestamp: Date.now(), latestVersion: prev.latestVersion });

    return NextResponse.json({
      updateAvailable,
      currentVersion: getVersion(),
      localCommit: localCommit.slice(0, 7),
      remoteCommit: remoteCommit.slice(0, 7),
      changes,
      lastCheck: prev.timestamp,
      checkedAt: Date.now(),
      checkStatus: "ok",
      // Whether the in-app updater can apply this (a git checkout). Pure Docker
      // image deploys update by pulling a new image / redeploying.
      canSelfUpdate: isGitCheckout(),
      mode,
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
        mode,
      },
      { status: 200 }
    );
  }
}

/**
 * POST /api/update — Install update (git self-update, or Coolify redeploy)
 */
export async function POST() {
  // Admin only — this can redeploy the app or run `git pull` + `npm install` +
  // `npm run build` on the server, so it MUST require an authenticated session.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const mode = updateMode();

  // Pre-flight 1: never trigger an update when the data dir isn't persisted —
  // a one-click update on top of unpersisted volumes is a one-click data loss.
  const guard = persistentDataStatus();
  if (!guard.ok) {
    return NextResponse.json(
      {
        success: false,
        restarting: false,
        mode,
        message: "Refusing to update: " + (guard.reason || "unpersisted data"),
      },
      { status: 200 }
    );
  }

  // "none" mode: updates are managed by the host.
  if (mode === "none") {
    return NextResponse.json(
      {
        success: false,
        restarting: false,
        mode,
        message:
          "Updates are managed by your host. Redeploy the application there " +
          "(e.g. `docker compose pull && docker compose up -d`, or re-run " +
          "install.sh).",
      },
      { status: 200 }
    );
  }

  // Pre-flight 2: refuse if an update is already in flight. This has to come
  // before the backup — otherwise every repeat click writes another full copy
  // of the database only to then be told the update is already running.
  if (isUpdateInFlight()) {
    return NextResponse.json({
      success: true,
      restarting: true,
      mode,
      message: "An update is already in progress.",
    });
  }

  // Pre-flight 3: back up the database before changing anything.
  try {
    const { createBackup } = await import("@/lib/backup");
    await createBackup("pre-update");
  } catch (e) {
    console.warn(
      "[backup] Pre-update backup skipped:",
      e instanceof Error ? e.message : e
    );
  }

  if (mode === "coolify") {
    const result = await startCoolifyUpdate();
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          restarting: false,
          mode,
          message:
            result.error ||
            `Coolify returned HTTP ${result.status ?? "unknown"}`,
        },
        { status: 200 }
      );
    }
    return NextResponse.json({
      success: true,
      restarting: true,
      mode,
      deploymentUuid: result.deploymentUuid,
      message:
        "Update started — Coolify is redeploying the app. It will restart " +
        "when the new image is ready.",
    });
  }

  // git path
  const { started, reason } = startUpdate();

  if (!started) {
    if (reason === "already-running") {
      return NextResponse.json({
        success: true,
        restarting: true,
        mode,
        message: "An update is already in progress.",
      });
    }
    return NextResponse.json({
      success: false,
      restarting: false,
      mode,
      message: "This deployment can't update itself in-app.",
    });
  }

  return NextResponse.json({
    success: true,
    restarting: true,
    mode,
    message:
      "Update started — the app will rebuild and restart automatically. " +
      "Please don't close this tab.",
  });
}
