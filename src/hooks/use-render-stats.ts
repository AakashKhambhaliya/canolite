"use client";

import { useQuery } from "@tanstack/react-query";
import type { RenderTimeStats } from "@/lib/render-time";

/**
 * Measured render times for this project, used for the "Est. time" readouts.
 *
 * Refetched on an interval because every completed render moves the numbers —
 * the estimate visibly sharpens as the project builds history.
 */
export function useRenderStats() {
  return useQuery<RenderTimeStats>({
    queryKey: ["render-stats"],
    queryFn: async () => {
      const res = await fetch("/api/renders/stats");
      if (!res.ok) throw new Error("Failed to load render stats");
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
