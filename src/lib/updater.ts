import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const ROOT = process.cwd();

/** Persisted update progress, so the client can poll across the restart. */
const STATUS_FILE = path.join(ROOT, ".update-status.json");

export type UpdatePhase =
  | "idle"
  | "pulling"
  | "installing"
  | "building"
  | "restarting"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
  fromCommit?: string;
  toCommit?: string;
  error?: string;
}

const IDLE: UpdateStatus = { phase: "idle" };

export function readStatus(): UpdateStatus {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return { ...IDLE, ...JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8")) };
    }
  } catch {}
  return IDLE;
}

function writeStatus(patch: Partial<UpdateStatus>): void {
  try {
    const next = { ...readStatus(), ...patch };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(next));
  } catch {}
}

/** True when this deployment is a git checkout we can self-update. */
export function isGitCheckout(): boolean {
  try {
    return fs.existsSync(path.join(ROOT, ".git"));
  } catch {
    return false;
  }
}

/** Run a shell command without blocking the event loop (so health checks stay
 *  green while we build). Rejects with stderr on a non-zero exit. */
function sh(cmd: string, timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd: ROOT, shell: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: ${cmd}`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out || `exited with code ${code}`).trim()));
    });
  });
}

/**
 * Kick off an update in the background and return immediately. The heavy work
 * (pull → install → build → restart) runs detached from the request so the
 * server keeps answering health checks until the final restart.
 */
export function startUpdate(): { started: boolean; reason?: string } {
  if (!isGitCheckout()) return { started: false, reason: "not-a-git-checkout" };

  const cur = readStatus();
  if (cur.phase !== "idle" && cur.phase !== "error") {
    return { started: false, reason: "already-running" };
  }

  writeStatus({
    phase: "pulling",
    message: "Pulling latest code…",
    startedAt: Date.now(),
    finishedAt: undefined,
    error: undefined,
    fromCommit: undefined,
    toCommit: undefined,
  });

  // Intentionally not awaited — runs in the background.
  void runUpdate();
  return { started: true };
}

async function runUpdate(): Promise<void> {
  try {
    const branch = (await sh("git rev-parse --abbrev-ref HEAD")) || "main";
    const fromCommit = await sh("git rev-parse HEAD");
    writeStatus({ fromCommit });

    // Discard stray local changes so --ff-only can't be blocked by a dirty tree.
    await sh("git stash --quiet || true").catch(() => {});
    await sh("git fetch origin --quiet");
    await sh(`git pull origin ${branch} --ff-only`);

    const toCommit = await sh("git rev-parse HEAD");
    writeStatus({ toCommit });

    // Reinstall deps only when the manifest changed — and DO NOT pass
    // --production: building needs the dev toolchain (next/typescript/tailwind).
    const changed = await sh(
      `git diff ${fromCommit} ${toCommit} --name-only`
    ).catch(() => "");
    if (/package(-lock)?\.json/.test(changed)) {
      writeStatus({ phase: "installing", message: "Installing dependencies…" });
      await sh("npm install --no-audit --no-fund");
    }

    // Rebuild so `next start` serves the new code. Without this the running
    // server keeps serving the stale .next build.
    writeStatus({ phase: "building", message: "Building the new version…" });
    await sh("npm run build");

    writeStatus({
      phase: "restarting",
      message: "Restarting…",
      finishedAt: Date.now(),
    });

    // Exit so the process supervisor (docker `restart: unless-stopped`, pm2,
    // systemd) relaunches us on the freshly built .next. The short delay lets
    // the HTTP response flush and the status file settle first.
    setTimeout(() => process.exit(0), 1500);
  } catch (e: unknown) {
    const error =
      e instanceof Error ? e.message : typeof e === "string" ? e : "Update failed";
    writeStatus({
      phase: "error",
      message: "Update failed.",
      error: error.slice(0, 800),
      finishedAt: Date.now(),
    });
  }
}
