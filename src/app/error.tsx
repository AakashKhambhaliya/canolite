"use client";

import { useEffect } from "react";

/**
 * Top-level error boundary. Without this a render/chunk failure (e.g. a stale
 * bundle right after an in-app update) white-screens the whole app with no way
 * to recover. Here we auto-reload once on the classic "stale deploy" chunk
 * errors, and otherwise give the user a Reload button.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isChunkError =
    error?.name === "ChunkLoadError" ||
    /Loading chunk [\d]+ failed|Loading CSS chunk|importing a module script failed/i.test(
      error?.message || ""
    );

  useEffect(() => {
    if (!isChunkError) return;
    // Reload once into the fresh build. Guard against an infinite loop if the
    // new build is also broken.
    const KEY = "canolite-chunk-reloaded";
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, "1");
    window.location.reload();
  }, [isChunkError]);

  // Clear the reload guard once the app renders fine again.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        sessionStorage.removeItem("canolite-chunk-reloaded");
      } catch {}
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
        {isChunkError ? "Reloading…" : "Something went wrong"}
      </h2>
      <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">
        {isChunkError
          ? "A newer version is loading. If this doesn't clear in a moment, reload the page."
          : "An unexpected error occurred. You can try again or reload the app."}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => reset()}
          className="h-9 px-4 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          className="h-9 px-4 rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
