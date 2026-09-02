"use client";

import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Save,
  Loader2,
  TestTube,
  Settings,
  Bell,
  Lock,
  HardDrive,
  Trash2,
  Timer,
} from "lucide-react";
import {
  OutputSettingsFields,
  type OutputSettingsValue,
} from "@/components/output-settings-fields";
import {
  FALLBACK_OUTPUT_SETTINGS,
  FORMAT_LABELS,
  VIDEO_QUALITY_LABELS,
  normalizeFormat,
  normalizeVideoQuality,
} from "@/lib/output-settings";
import { useRenderStats } from "@/hooks/use-render-stats";
import { formatRenderTime } from "@/lib/render-time";

/** Retention choices, in hours. */
const RETENTION_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1 hour" },
  { value: 6, label: "6 hours" },
  { value: 12, label: "12 hours" },
  { value: 24, label: "24 hours" },
  { value: 72, label: "3 days" },
  { value: 168, label: "7 days" },
  { value: 720, label: "30 days" },
];

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  // One object for every output default — image and video alike. This is the
  // single set of values the editor, the Playground and the API all resolve
  // against (lib/output-settings.ts).
  const [output, setOutput] = useState<OutputSettingsValue>({
    format: FALLBACK_OUTPUT_SETTINGS.format,
    quality: FALLBACK_OUTPUT_SETTINGS.quality,
    scale: FALLBACK_OUTPUT_SETTINGS.scale,
    fps: FALLBACK_OUTPUT_SETTINGS.fps,
    videoQuality: FALLBACK_OUTPUT_SETTINGS.videoQuality,
  });
  const [retentionHours, setRetentionHours] = useState(24);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [cleaning, setCleaning] = useState<"retention" | "all" | null>(null);

  // Change-password form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPw, setChangingPw] = useState(false);

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword) {
      toast.error("Enter your current and new password");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }
    setChangingPw(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to change password");
        return;
      }
      toast.success("Password updated");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      toast.error("Failed to change password");
    } finally {
      setChangingPw(false);
    }
  };

  // Load current settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
  });

  /**
   * How much there is to clean up right now.
   *
   * Without this the "Clean Now" button was a black box: on a project whose
   * renders were all newer than the retention period it correctly deleted
   * nothing and reported "Cleaned up 0 old renders", which reads as broken.
   * Showing the two counts up front makes the outcome predictable.
   */
  const { data: cleanupStatus } = useQuery<{
    pending: number;
    total: number;
    retention_hours: number;
  }>({
    queryKey: ["cleanup-status"],
    queryFn: async () => {
      const res = await fetch("/api/cleanup");
      if (!res.ok) throw new Error("Failed to load cleanup status");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const { data: renderStats } = useRenderStats();

  // Populate form when settings load
  useEffect(() => {
    if (settings) {
      setWebhookUrl(settings.webhookUrl || "");
      setWebhookSecret(settings.webhookSecret || "");
      setOutput({
        format:
          normalizeFormat(settings.defaultFormat) ??
          FALLBACK_OUTPUT_SETTINGS.format,
        quality: settings.defaultQuality ?? FALLBACK_OUTPUT_SETTINGS.quality,
        scale: settings.defaultScale ?? FALLBACK_OUTPUT_SETTINGS.scale,
        fps: settings.defaultFps ?? FALLBACK_OUTPUT_SETTINGS.fps,
        videoQuality:
          normalizeVideoQuality(settings.defaultVideoQuality) ??
          FALLBACK_OUTPUT_SETTINGS.videoQuality,
      });
      setRetentionHours(settings.retentionHours ?? 24);
    }
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl,
          webhookSecret,
          defaultFormat: output.format || FALLBACK_OUTPUT_SETTINGS.format,
          defaultQuality:
            output.quality === "" || output.quality === undefined
              ? FALLBACK_OUTPUT_SETTINGS.quality
              : output.quality,
          defaultScale:
            output.scale === "" || output.scale === undefined
              ? FALLBACK_OUTPUT_SETTINGS.scale
              : output.scale,
          defaultFps:
            output.fps === "" || output.fps === undefined
              ? FALLBACK_OUTPUT_SETTINGS.fps
              : output.fps,
          defaultVideoQuality:
            output.videoQuality || FALLBACK_OUTPUT_SETTINGS.videoQuality,
          retentionHours,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }
      // Every other screen resolves against these values, so refresh them.
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["cleanup-status"] });
      toast.success("Settings saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    } finally {
      setSaving(false);
    }
  };

  /**
   * Run a cleanup. `scope: "retention"` applies the period shown in the form
   * right now (so it works without saving first); `scope: "all"` deletes every
   * render regardless of age.
   */
  const runCleanup = async (scope: "retention" | "all") => {
    if (
      scope === "all" &&
      !window.confirm(
        `Delete all ${cleanupStatus?.total ?? ""} renders and their files? This can't be undone.`
      )
    ) {
      return;
    }
    setCleaning(scope);
    try {
      const res = await fetch("/api/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope === "all" ? { scope } : { scope, retentionHours }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        toast.error(data.error || "Cleanup failed");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["cleanup-status"] });
      queryClient.invalidateQueries({ queryKey: ["renders"] });
      queryClient.invalidateQueries({ queryKey: ["render-stats"] });

      if (data.deleted === 0) {
        // Say why nothing happened instead of reporting a hollow success.
        toast.info(
          scope === "all"
            ? "There were no renders to delete"
            : `Nothing to clean — no renders are older than ${retentionHours}h`
        );
        return;
      }
      toast.success(
        `Deleted ${data.deleted} render${data.deleted === 1 ? "" : "s"}` +
          (data.errors ? ` (${data.errors} file errors)` : "")
      );
    } catch {
      toast.error("Cleanup failed");
    } finally {
      setCleaning(null);
    }
  };

  const handleTestWebhook = async () => {
    if (!webhookUrl) {
      toast.error("Enter a webhook URL first");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/settings/webhook-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl }),
      });
      if (res.ok) {
        toast.success("Test webhook sent successfully");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Webhook test failed");
      }
    } catch {
      toast.error("Failed to test webhook");
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  const summary = [
    FORMAT_LABELS[
      (normalizeFormat(output.format) ?? FALLBACK_OUTPUT_SETTINGS.format)
    ],
    `${output.scale || 1}x`,
    `quality ${output.quality || FALLBACK_OUTPUT_SETTINGS.quality}`,
    `${output.fps || FALLBACK_OUTPUT_SETTINGS.fps} fps`,
    VIDEO_QUALITY_LABELS[
      normalizeVideoQuality(output.videoQuality) ??
        FALLBACK_OUTPUT_SETTINGS.videoQuality
    ].toLowerCase(),
  ].join(" · ");

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gray-600 to-gray-800 flex items-center justify-center">
            <Settings className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground">
              Configuration and preferences
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Webhooks */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Webhooks</CardTitle>
            </div>
            <CardDescription>
              Receive notifications when renders complete or fail
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Webhook URL</Label>
              <Input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://example.com/webhook"
              />
            </div>
            <div className="space-y-2">
              <Label>Webhook Secret</Label>
              <Input
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="Optional signing secret"
                type="password"
              />
              <p className="text-xs text-muted-foreground">
                If set, payloads are signed with HMAC-SHA256 in the{" "}
                <code className="text-xs">X-Webhook-Signature</code> header
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestWebhook}
              disabled={testing}
            >
              {testing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <TestTube className="mr-2 h-4 w-4" />
              )}
              Send Test Webhook
            </Button>
          </CardContent>
        </Card>

        {/* Universal output defaults */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Output Settings</CardTitle>
            <CardDescription>
              The defaults for every render — the editor&apos;s Output panel and
              Export dialog, the Playground, and API requests that don&apos;t
              specify their own. Templates and individual requests can still
              override any field; everything else follows what you set here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <OutputSettingsFields
              value={output}
              onChange={(patch) => setOutput((prev) => ({ ...prev, ...patch }))}
              allowVideo
              videoFields="always"
              // Clip length is per render (default: as long as the timeline
              // needs), so there is nothing sensible to store as a global one.
              showDuration={false}
            />
            <p className="text-xs text-muted-foreground">
              Current default: {summary}
            </p>
          </CardContent>
        </Card>

        {/* Render performance */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Render Times</CardTitle>
            </div>
            <CardDescription>
              Measured from this project&apos;s completed renders. These are the
              numbers behind the estimates shown before you render.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Images (typical)</span>
                <p className="mt-1 font-medium">
                  {renderStats?.image
                    ? `${formatRenderTime(renderStats.image.medianMs)} · ${
                        renderStats.image.samples
                      } sample${renderStats.image.samples === 1 ? "" : "s"}`
                    : "No completed image renders yet"}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Videos (typical)</span>
                <p className="mt-1 font-medium">
                  {renderStats?.video
                    ? `${formatRenderTime(renderStats.video.medianMs)} · ${
                        renderStats.video.samples
                      } sample${renderStats.video.samples === 1 ? "" : "s"}`
                    : "No completed video renders yet"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Storage & cleanup */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Storage</CardTitle>
            </div>
            <CardDescription>
              Rendered files are auto-deleted after the retention period. You can
              also clear them yourself at any time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Retention Period</Label>
                <Select
                  value={String(retentionHours)}
                  onValueChange={(v) => setRetentionHours(Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RETENTION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={String(opt.value)}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {cleanupStatus &&
                  cleanupStatus.retention_hours !== retentionHours && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      Unsaved — the automatic sweep still uses{" "}
                      {cleanupStatus.retention_hours}h until you save. Manual
                      cleanup below uses the {retentionHours}h shown here.
                    </p>
                  )}
              </div>
              <div className="space-y-2">
                <Label>Manual Cleanup</Label>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={cleaning !== null}
                    onClick={() => runCleanup("retention")}
                    title={`Delete renders older than ${retentionHours}h`}
                  >
                    {cleaning === "retention" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Clean Now
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 text-destructive hover:text-destructive"
                    disabled={cleaning !== null || cleanupStatus?.total === 0}
                    onClick={() => runCleanup("all")}
                    title="Delete every render in this project, whatever its age"
                  >
                    {cleaning === "all" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Delete All
                  </Button>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {cleanupStatus ? (
                <>
                  <strong>{cleanupStatus.total}</strong> render
                  {cleanupStatus.total === 1 ? "" : "s"} stored,{" "}
                  <strong>{cleanupStatus.pending}</strong> past the{" "}
                  {cleanupStatus.retention_hours}h retention period.{" "}
                  {cleanupStatus.pending === 0 && cleanupStatus.total > 0
                    ? "“Clean Now” will delete nothing until renders age past the period — use “Delete All” to clear them immediately."
                    : ""}
                </>
              ) : (
                "Checking stored renders…"
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              The automatic sweep runs on every server restart and hourly while
              running, and only removes finished renders.
            </p>
          </CardContent>
        </Card>

        {/* Admin password */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Admin Password</CardTitle>
            </div>
            <CardDescription>
              Change your sign-in password. You must enter your current password
              to confirm it&apos;s you.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 max-w-sm">
              <Label>Current password</Label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>New password</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <Label>Confirm new password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleChangePassword}
              disabled={changingPw}
            >
              {changingPw ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              Update Password
            </Button>
          </CardContent>
        </Card>


        {/* Save */}
        <div className="flex justify-end">
          <Button variant="accent" onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save Changes
          </Button>
        </div>
      </div>
    </div>
  );
}
