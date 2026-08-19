/**
 * Persistence guard shared by the boot sequence (instrumentation) and the
 * update pre-flight check. Reports whether /app/data is a mounted volume —
 * the thing that survives a Coolify redeploy.
 */
import fs from "fs";

export const DATA_DIR = "/app/data";

export interface PersistenceStatus {
  ok: boolean;
  reason?: string;
}

export function persistentDataStatus(): PersistenceStatus {
  if (process.env.REQUIRE_PERSISTENT_DATA !== "1") return { ok: true };

  let appStat: fs.Stats;
  try {
    appStat = fs.statSync("/app");
  } catch {
    return { ok: true }; // no /app (local dev) — nothing to guard
  }

  let dataStat: fs.Stats;
  try {
    dataStat = fs.statSync(DATA_DIR);
  } catch {
    return {
      ok: false,
      reason:
        DATA_DIR +
        " does not exist. Mount a persistent volume at " +
        DATA_DIR +
        " (Coolify → Storages).",
    };
  }

  if (dataStat.dev === appStat.dev) {
    return {
      ok: false,
      reason:
        DATA_DIR +
        " is not a mounted volume — it lives in the container's image layer " +
        "and will be wiped on every redeploy. Mount a persistent volume at " +
        DATA_DIR +
        " (Coolify → Storages).",
    };
  }

  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch {
    return { ok: false, reason: DATA_DIR + " is not writable." };
  }

  return { ok: true };
}
