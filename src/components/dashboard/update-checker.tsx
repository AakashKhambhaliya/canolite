"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowDownCircle,
  Check,
  Loader2,
  RefreshCw,
  Download,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  localCommit: string;
  remoteCommit: string;
  changes: string[];
  lastCheck: number;
  checkedAt: number;
  canSelfUpdate?: boolean;
  error?: string;
}

const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const RESTART_TIMEOUT = 8 * 60 * 1000; // give the rebuild+restart up to 8 min

const PHASE_LABELS: Record<string, string> = {
  pulling: "Pulling latest code…",
  installing: "Installing dependencies…",
  building: "Building the new version…",
  restarting: "Restarting…",
};

export function UpdateChecker({ collapsed }: { collapsed: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartPhase, setRestartPhase] = useState<string>("pulling");
  const [restartStuck, setRestartStuck] = useState(false);
  const pollingRef = useRef(false);

  const checkForUpdates = useCallback(async (silent = false) => {
    setChecking(true);
    try {
      const res = await fetch("/api/update");
      const data = await res.json();
      setInfo(data);
      // Only surface errors for manual checks — the automatic check shouldn't
      // spam toasts (e.g. Docker deploys have no .git so it always "fails").
      if (data.error && !silent) {
        toast.error("Update check failed: " + data.error);
      }
    } catch (e) {
      if (!silent) toast.error("Failed to check for updates");
    } finally {
      setChecking(false);
    }
  }, []);

  /**
   * Once the update is kicked off the server rebuilds and then restarts itself.
   * We poll: track progress, wait for the server to go *down* (the restart) and
   * come back *up* on the new build, then reload into it. This is what keeps the
   * flow from getting stuck "at restart".
   */
  const pollUntilRestarted = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const startedAt = Date.now();
    let sawDown = false;

    const tick = async () => {
      if (Date.now() - startedAt > RESTART_TIMEOUT) {
        pollingRef.current = false;
        setRestartStuck(true);
        return;
      }

      // Progress + failure detection (best-effort; fails while server is down).
      try {
        const s = await fetch("/api/update/status", {
          cache: "no-store",
        }).then((r) => r.json());
        if (s.phase === "error") {
          pollingRef.current = false;
          setRestarting(false);
          setInstalling(false);
          toast.error("Update failed: " + (s.error || "unknown error"));
          return;
        }
        if (s.phase && s.phase !== "idle") setRestartPhase(s.phase);
      } catch {
        /* server is mid-restart — ignore */
      }

      // Liveness probe.
      let up = false;
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        up = r.ok;
      } catch {
        up = false;
      }

      if (!up) {
        sawDown = true;
      } else if (sawDown) {
        // The new build is live — reload into it.
        window.location.reload();
        return;
      }

      setTimeout(tick, 2000);
    };

    tick();
  }, []);

  const installUpdate = useCallback(async () => {
    setInstalling(true);
    setRestartStuck(false);
    try {
      const res = await fetch("/api/update", { method: "POST" });
      const data = await res.json();

      if (data.success && data.restarting) {
        // Update is running in the background; wait for the restart.
        setInstalled(true);
        setRestarting(true);
        setRestartPhase("pulling");
        toast.success(data.message || "Updating…");
        pollUntilRestarted();
      } else {
        // e.g. not a git checkout — can't self-update.
        toast.error(data.message || "Update failed");
        setInstalling(false);
      }
    } catch {
      toast.error("Failed to start update");
      setInstalling(false);
    }
  }, [pollUntilRestarted]);

  // Auto-check on mount + every 24 hours (silent — no error toasts)
  useEffect(() => {
    checkForUpdates(true);
    const interval = setInterval(() => checkForUpdates(true), CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [checkForUpdates]);

  const restartLabel = restartStuck
    ? "Update applied — restart the server, then reload"
    : PHASE_LABELS[restartPhase] || "Updating…";

  // --- Collapsed: just an icon with a tooltip ---------------------------------
  if (collapsed) {
    return (
      <div className="px-3 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() =>
                restarting
                  ? restartStuck && window.location.reload()
                  : info?.updateAvailable && !installed
                  ? installUpdate()
                  : checkForUpdates()
              }
              disabled={checking || installing || (restarting && !restartStuck)}
              className={cn(
                "w-full flex items-center justify-center py-2.5 rounded-lg transition-colors",
                info?.updateAvailable && !installed
                  ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400"
                  : "text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-800"
              )}
            >
              {restarting && !restartStuck ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : restartStuck ? (
                <RefreshCw className="h-5 w-5" />
              ) : checking || installing ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : info?.updateAvailable && !installed ? (
                <ArrowDownCircle className="h-5 w-5" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {restarting
              ? restartLabel
              : checking
              ? "Checking for updates…"
              : installing
              ? "Installing update…"
              : info?.updateAvailable && !installed
              ? "Update available — click to install"
              : `v${info?.currentVersion || "?"} — Up to date`}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  // --- Expanded sidebar -------------------------------------------------------

  // Restarting / rebuilding state takes priority over everything else.
  if (restarting) {
    return (
      <div className="px-3 pb-2">
        <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            {restartStuck ? (
              <RefreshCw className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            ) : (
              <Loader2 className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 animate-spin" />
            )}
            <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">
              {restartStuck ? "Almost there" : "Updating…"}
            </span>
          </div>
          <p className="text-[10px] text-blue-600/80 dark:text-blue-400/70 leading-relaxed">
            {restartLabel}
          </p>
          {restartStuck ? (
            <button
              onClick={() => window.location.reload()}
              className="mt-1 w-full h-7 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors"
            >
              Reload now
            </button>
          ) : (
            <p className="text-[10px] text-blue-500/70 dark:text-blue-400/50">
              Don&apos;t close this tab — it&apos;ll reload automatically.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 pb-2">
      {info?.updateAvailable && !installed ? (
        /* Update available state */
        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <ArrowDownCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              Update available
            </span>
          </div>

          {info.changes.length > 0 && (
            <div className="max-h-20 overflow-y-auto space-y-0.5">
              {info.changes.slice(0, 5).map((c, i) => (
                <p
                  key={i}
                  className="text-[10px] text-emerald-600/80 dark:text-emerald-400/70 truncate leading-relaxed"
                >
                  • {c}
                </p>
              ))}
              {info.changes.length > 5 && (
                <p className="text-[10px] text-emerald-600/60 dark:text-emerald-400/50">
                  +{info.changes.length - 5} more changes
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={installUpdate}
              disabled={installing}
              className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium transition-colors disabled:opacity-50"
            >
              {installing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {installing ? "Installing…" : "Install Update"}
            </button>
            <button
              onClick={() => checkForUpdates()}
              disabled={checking}
              className="h-8 w-8 flex items-center justify-center rounded-md bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-900/50 transition-colors"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", checking && "animate-spin")}
              />
            </button>
          </div>
        </div>
      ) : (
        /* Up-to-date state */
        <button
          onClick={() => checkForUpdates()}
          disabled={checking}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors group"
        >
          {checking ? (
            <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" />
          ) : installed ? (
            <Check className="h-4 w-4 text-emerald-500 shrink-0" />
          ) : (
            <RefreshCw className="h-4 w-4 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-400 truncate">
              {checking
                ? "Checking…"
                : installed
                ? "Updated!"
                : `v${info?.currentVersion || "?"} — Up to date`}
            </p>
            {info?.localCommit && !checking && (
              <p className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">
                {info.localCommit}
              </p>
            )}
          </div>
        </button>
      )}
    </div>
  );
}
