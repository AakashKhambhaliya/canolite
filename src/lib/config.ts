import os from "os";
import { z } from "zod";

const intFromEnv = (fallback: number) =>
  z.preprocess((value) => (value === undefined || value === "" ? fallback : value), z.coerce.number().int());

const numberFromEnv = (fallback: number) =>
  z.preprocess((value) => (value === undefined || value === "" ? fallback : value), z.coerce.number());

const stringFromEnv = (fallback: string) =>
  z.preprocess((value) => (value === undefined || value === "" ? fallback : value), z.string());

const envSchema = z.object({
  MAX_UPLOAD_MB: intFromEnv(10),
  MAX_VIDEO_UPLOAD_MB: intFromEnv(100),
  MAX_VIDEO_DURATION_SEC: numberFromEnv(60),
  MAX_VIDEO_PIXELS: intFromEnv(8294400),
  RENDER_TIMEOUT_MS: intFromEnv(60_000),
  RENDER_CONCURRENCY: intFromEnv(3),
  VIDEO_RENDER_TIMEOUT_MS: intFromEnv(900_000),
  VIDEO_DEFAULT_FPS: intFromEnv(30),
  VIDEO_MAX_FPS: intFromEnv(60),
  VIDEO_MAX_OUTPUT_SEC: intFromEnv(120),
  VIDEO_CONCURRENCY: intFromEnv(1),
  VIDEO_PROBE_TIMEOUT_MS: intFromEnv(60_000),
  VIDEO_POSTER_TIMEOUT_MS: intFromEnv(60_000),
  VIDEO_DECODE_TIMEOUT_MS: intFromEnv(300_000),
  // Fast-path renderer tuning (docs/video-rendering.md).
  VIDEO_FFMPEG_LOOP_MEMORY_MB: intFromEnv(512),
  VIDEO_ENCODER: stringFromEnv("libx264"),
});

export const config = envSchema.parse(process.env);
