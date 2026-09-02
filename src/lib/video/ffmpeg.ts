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

export interface RunFfmpegProgressOptions extends RunFfmpegOptions {
  /** Expected output duration in seconds, for -progress fraction mapping. */
  totalSec?: number;
  /** Called with encode progress as a 0..1 fraction (throttling is the caller's job). */
  onProgress?: (fraction: number) => void;
}

/**
 * Run ffmpeg with `-progress pipe:1` style output expected on stdout (the
 * caller appends those flags; this runner only parses them). ffmpeg prints
 * key=value lines; out_time_us/out_time_ms are both in microseconds (the
 * _ms variant is a long-standing misnomer), with out_time as a fallback.
 */
export function runFfmpegWithProgress(args: string[], options: RunFfmpegProgressOptions = {}): Promise<void> {
  const binary = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let stdoutBuf = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const emitProgress = () => {
      if (!options.onProgress || !options.totalSec || options.totalSec <= 0) return;
      // The buffer holds MANY progress lines — always take the LAST match,
      // never the first (which is up to a buffer's worth of time stale).
      const usMatches = [...stdoutBuf.matchAll(/out_time_us=(-?\d+)/g)];
      const msMatches = usMatches.length > 0 ? [] : [...stdoutBuf.matchAll(/out_time_ms=(-?\d+)/g)];
      const timeMatches = usMatches.length + msMatches.length > 0 ? [] : [...stdoutBuf.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      let seconds: number | null = null;
      if (usMatches.length > 0) {
        seconds = Number(usMatches[usMatches.length - 1][1]) / 1e6;
      } else if (msMatches.length > 0) {
        seconds = Number(msMatches[msMatches.length - 1][1]) / 1e6;
      } else if (timeMatches.length > 0) {
        const t = timeMatches[timeMatches.length - 1];
        seconds = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      }
      if (seconds === null || !Number.isFinite(seconds)) return;
      options.onProgress(Math.min(1, Math.max(0, seconds / options.totalSec)));
    };

    child.stdout.on("data", (chunk: string) => {
      stdoutBuf = (stdoutBuf + chunk).slice(-8192);
      emitProgress();
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
      if (code === 0) return resolve();
      reject(
        new Error(
          `${binary} failed${code !== null ? ` with exit code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}` +
            (stderr.trim() ? `: ${stderr.trim().slice(-4000)}` : "")
        )
      );
    });
  });
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
