"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
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
} from "lucide-react";

export default function SettingsPage() {
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [defaultFormat, setDefaultFormat] = useState("png");
  const [defaultQuality, setDefaultQuality] = useState(90);
  const [defaultScale, setDefaultScale] = useState(1);
  const [retentionHours, setRetentionHours] = useState(24);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [cleaning, setCleaning] = useState(false);

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

  // Populate form when settings load
  useEffect(() => {
    if (settings) {
      setWebhookUrl(settings.webhookUrl || "");
      setWebhookSecret(settings.webhookSecret || "");
      setDefaultFormat(settings.defaultFormat || "png");
      setDefaultQuality(settings.defaultQuality ?? 90);
      setDefaultScale(settings.defaultScale ?? 1);
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
          defaultFormat,
          defaultQuality,
          defaultScale,
          retentionHours,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
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

        {/* Default output */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Default Output Settings
            </CardTitle>
            <CardDescription>
              Applied when API requests don&apos;t specify output parameters
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Format</Label>
                <Select
                  value={defaultFormat}
                  onValueChange={setDefaultFormat}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="png">PNG</SelectItem>
                    <SelectItem value="jpg">JPG</SelectItem>
                    <SelectItem value="webp">WebP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Quality</Label>
                <Input
                  type="number"
                  value={defaultQuality}
                  onChange={(e) =>
                    setDefaultQuality(Number(e.target.value))
                  }
                  min={1}
                  max={100}
                />
              </div>
              <div className="space-y-2">
                <Label>Scale</Label>
                <Select
                  value={String(defaultScale)}
                  onValueChange={(v) => setDefaultScale(Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1x</SelectItem>
                    <SelectItem value="2">2x</SelectItem>
                    <SelectItem value="3">3x</SelectItem>
                  </SelectContent>
                </Select>
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
              Rendered images are auto-deleted after the retention period
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
                    <SelectItem value="1">1 hour</SelectItem>
                    <SelectItem value="6">6 hours</SelectItem>
                    <SelectItem value="12">12 hours</SelectItem>
                    <SelectItem value="24">24 hours</SelectItem>
                    <SelectItem value="72">3 days</SelectItem>
                    <SelectItem value="168">7 days</SelectItem>
                    <SelectItem value="720">30 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Manual Cleanup</Label>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={cleaning}
                  onClick={async () => {
                    setCleaning(true);
                    try {
                      const res = await fetch("/api/cleanup", { method: "POST" });
                      const data = await res.json();
                      if (data.success) {
                        toast.success(`Cleaned up ${data.deleted} old renders`);
                      } else {
                        toast.error("Cleanup failed");
                      }
                    } catch {
                      toast.error("Cleanup failed");
                    } finally {
                      setCleaning(false);
                    }
                  }}
                >
                  {cleaning ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  Clean Now
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Completed renders older than the retention period are automatically
              deleted on every server restart and periodically while running.
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
