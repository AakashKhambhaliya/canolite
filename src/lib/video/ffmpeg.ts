import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const resolved = require("ffmpeg-static");
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error(
    "ffmpeg binary not found. Install ffmpeg-static, install ffmpeg on the host, " +
      "or set FFMPEG_PATH to the absolute ffmpeg executable path."
  );
}

export function getFfprobePath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    const resolved = require("ffprobe-static");
    const path = typeof resolved === "string" ? resolved : resolved?.path;
    if (typeof path === "string" && path.length > 0) return path;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error(
    "ffprobe binary not found. Install ffprobe-static, install ffprobe on the host, " +
      "or set FFPROBE_PATH to the absolute ffprobe executable path."
  );
}

export interface RunFfmpegOptions {
  onStderr?: (chunk: string) => void;
  cwd?: string;
  timeoutMs?: number;
}

export function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<void> {
  return runProcess(getFfmpegPath(), args, options);
}

export function runFfprobe(args: string[], options: RunFfmpegOptions = {}): Promise<string> {
  return runProcessCaptureStdout(getFfprobePath(), args, options);
}

export function spawnFfmpegPipe(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(getFfmpegPath(), args, { stdio: ["pipe", "pipe", "pipe"] });
}

function timeoutMessage(binary: string, timeoutMs: number): string {
  return `${binary} timed out after ${timeoutMs}ms`;
}

function runProcess(binary: string, args: string[], options: RunFfmpegOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut && options.timeoutMs) return reject(new Error(timeoutMessage(binary, options.timeoutMs)));
      if (code === 0) return resolve();
      reject(
        new Error(
          `${binary} failed${code !== null ? ` with exit code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}` +
            (stderr.trim() ? `: ${stderr.trim()}` : "")
        )
      );
    });
  });
}

function runProcessCaptureStdout(
  binary: string,
  args: string[],
  options: RunFfmpegOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut && options.timeoutMs) return reject(new Error(timeoutMessage(binary, options.timeoutMs)));
      if (code === 0) return resolve(stdout);
      reject(
        new Error(
          `${binary} failed${code !== null ? ` with exit code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}` +
            (stderr.trim() ? `: ${stderr.trim()}` : "")
        )
      );
    });
  });
}
