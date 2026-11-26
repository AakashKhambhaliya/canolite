import { promises as fs } from "fs";
import path from "path";
import { config } from "@/lib/config";
import { runFfmpeg } from "./ffmpeg";

/** ffmpeg ran cleanly but wrote no frame (e.g. the timestamp is at/after EOF). */
export class PosterUnavailableError extends Error {
  constructor() {
    super("No frame could be extracted at that time; choose an earlier timestamp.");
    this.name = "PosterUnavailableError";
  }
}

export async function extractPoster(filePath: string, atSec: number, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const timestamp = Math.max(0, Number.isFinite(atSec) ? atSec : 0).toString();
  await runFfmpeg(
    [
      "-hide_banner",
      "-v",
      "error",
      "-ss",
      timestamp,
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-y",
      outPath,
    ],
    { timeoutMs: config.VIDEO_POSTER_TIMEOUT_MS }
  );
  // Seeking to (or past) the last frame exits 0 without writing anything.
  const stat = await fs.stat(outPath).catch(() => null);
  if (!stat || stat.size === 0) throw new PosterUnavailableError();
}
