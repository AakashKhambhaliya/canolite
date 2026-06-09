"use client";

import { useEffect } from "react";

/**
 * Root error boundary — catches failures in the root layout itself, where the
 * normal error.tsx can't help. Renders its own <html>/<body> as required by
 * Next.js. Auto-reloads once on stale-chunk errors so a mid-update refresh
 * recovers instead of bricking the app.
 */
export default function GlobalError({
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
    const KEY = "canolite-chunk-reloaded";
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, "1");
    window.location.reload();
  }, [isChunkError]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#fff",
          color: "#111",
          textAlign: "center",
          padding: "2rem",
        }}
      >
        <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>
          {isChunkError ? "Reloading…" : "Something went wrong"}
        </h2>
        <p style={{ maxWidth: "28rem", fontSize: "0.875rem", color: "#666" }}>
          {isChunkError
            ? "A newer version is loading. If this doesn't clear in a moment, reload the page."
            : "An unexpected error occurred. Reload the app to continue."}
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            onClick={() => reset()}
            style={{
              height: "2.25rem",
              padding: "0 1rem",
              borderRadius: "0.375rem",
              border: "1px solid #d1d5db",
              background: "#fff",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              height: "2.25rem",
              padding: "0 1rem",
              borderRadius: "0.375rem",
              border: "none",
              background: "#111",
              color: "#fff",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
