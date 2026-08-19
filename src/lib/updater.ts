import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const ROOT = process.cwd();

/**
 * Update state lives on the persistent volume (/app/data) when one is mounted,
 * so it survives the container swap that a Coolify redeploy performs. On a bare
 * VPS / git checkout (no /app/data) it falls back to the working directory,
 * preserving the existing self-update behavior.
 */
const STATE_DIR = fs.existsSync("/app/data") ? "/app/data" : ROOT;

/** Persisted update progress, so the client can poll across the restart. */
const STATUS_FILE = path.join(STATE_DIR, ".update-status.json");

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

/**
 * How this deployment updates itself:
 *  - "coolify" → ask Coolify to redeploy (the container does not rebuild itself)
 *  - "git"      → the existing pull → install → build → restart path
 *  - "none"     → updates are managed by the host
 */
export function updateMode(): "coolify" | "git" | "none" {
  if (
    process.env.COOLIFY_API_TOKEN &&
    process.env.COOLIFY_APP_UUID &&
    process.env.COOLIFY_URL
  ) {
    return "coolify";
  }
  if (isGitCheckout()) return "git";
  return "none";
}

/**
 * Whether an update is currently in flight. A "restarting"/"building" status
 * older than 20 minutes is treated as stale (e.g. the Coolify swap finished and
 * the new container booted with the old status file still on the volume).
 */
export function isUpdateInFlight(): boolean {
  const cur = readStatus();
  if (cur.phase === "idle" || cur.phase === "error") return false;
  if (cur.startedAt && Date.now() - cur.startedAt > 20 * 60_000) return false;
  return true;
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
 * Ask Coolify to queue a redeploy of this application. The verified endpoint is
 * `POST {COOLIFY_URL}/api/v1/deploy` with `Authorization: Bearer {token}` and
 * body `{"uuid": "<COOLIFY_APP_UUID>", "force": false}`. On success Coolify
 * returns a deployment UUID; on failure we surface the status and body.
 */
export async function triggerCoolifyDeploy(): Promise<{
  success: boolean;
  deploymentUuid?: string;
  status?: number;
  error?: string;
}> {
  const base = (process.env.COOLIFY_URL || "").replace(/\/+$/, "");
  const token = process.env.COOLIFY_API_TOKEN || "";
  const uuid = process.env.COOLIFY_APP_UUID || "";

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/deploy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uuid, force: false }),
      // Without this an unreachable-but-accepting Coolify hangs POST /api/update
      // forever, leaving the status file stuck on "restarting" for 20 minutes.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return {
      success: false,
      error: `Failed to reach Coolify: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON body — fall through to text
  }

  if (!res.ok) {
    return {
      success: false,
      status: res.status,
      error: text || `Coolify returned HTTP ${res.status}`,
    };
  }

  return {
    success: true,
    deploymentUuid:
      data.deployment_uuid || data.deploymentUuid || data.uuid || undefined,
  };
}

/**
 * Kick off a git self-update in the background and return immediately. The
 * heavy work (pull → install → build → restart) runs detached from the request
 * so the server keeps answering health checks until the final restart.
 */
export function startUpdate(): { started: boolean; reason?: string } {
  const mode = updateMode();

  if (mode === "none") {
    return { started: false, reason: "none" };
  }

  if (isUpdateInFlight()) {
    return { started: false, reason: "already-running" };
  }

  // git path (unchanged behavior)
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

/**
 * Queue a Coolify redeploy and return its result synchronously, so the client
 * gets immediate feedback on whether the deploy was queued. Writes progress to
 * the status file (on the persistent volume) so it survives the swap, but the
 * client detects completion by watching /api/health for a commit change.
 */
export async function startCoolifyUpdate(): Promise<{
  success: boolean;
  deploymentUuid?: string;
  status?: number;
  error?: string;
}> {
  writeStatus({
    phase: "restarting",
    message: "Requesting redeploy from Coolify…",
    startedAt: Date.now(),
    finishedAt: undefined,
    error: undefined,
    fromCommit: process.env.GIT_SHA,
    toCommit: undefined,
  });

  const result = await triggerCoolifyDeploy();

  if (!result.success) {
    writeStatus({
      phase: "error",
      message: "Coolify deploy failed.",
      error: (result.error || `HTTP ${result.status}`).slice(0, 800),
      finishedAt: Date.now(),
    });
    return result;
  }

  writeStatus({
    phase: "restarting",
    message: "Coolify is rebuilding the image…",
    finishedAt: Date.now(),
  });
  return result;
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
