"use client";

import { useQuery } from "@tanstack/react-query";
import {
  projectDefaultsLayer,
  resolveOutputSettings,
  type OutputSettings,
} from "@/lib/output-settings";

export interface ProjectSettings {
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  defaultFormat?: string | null;
  defaultQuality?: number | null;
  defaultScale?: number | null;
  defaultFps?: number | null;
  defaultVideoQuality?: string | null;
  retentionHours?: number | null;
}

/**
 * The project's settings row. Shared query key with the Settings page, so
 * saving there immediately updates every surface that resolves against these
 * defaults (editor Output popover, Export dialog, Playground).
 */
export function useProjectSettings() {
  return useQuery<ProjectSettings>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
    staleTime: 30_000,
  });
}

/**
 * The universal output defaults, fully resolved.
 *
 * Everything that renders — the editor, the Playground, the API — starts from
 * this same object, so there is one place to change a default and it is
 * honoured everywhere. While the query is loading this returns the hardcoded
 * fallbacks rather than nothing, so forms never render empty.
 */
export function useOutputDefaults(): {
  defaults: OutputSettings;
  isLoading: boolean;
} {
  const { data, isLoading } = useProjectSettings();
  return {
    defaults: resolveOutputSettings(projectDefaultsLayer(data)),
    isLoading,
  };
}
