import { promises as fs } from "fs";
import path from "path";
import { config } from "@/lib/config";
import { runFfmpeg } from "./ffmpeg";

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
}
