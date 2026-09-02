"use client";
/* eslint-disable @next/next/no-img-element */

import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { toast } from "sonner";
import {
  Copy,
  Loader2,
  Sparkles,
  FileImage,
  Zap,
  Download,
  Video,
  Timer,
} from "lucide-react";
import { copyToClipboard } from "@/lib/utils";
import {
  OutputSettingsFields,
  type OutputSettingsValue,
} from "@/components/output-settings-fields";
import {
  estimateOutputSizeLabel,
  resolveOutputSettings,
  type PartialOutputSettings,
} from "@/lib/output-settings";
import { useOutputDefaults } from "@/hooks/use-output-settings";
import { useRenderStats } from "@/hooks/use-render-stats";
import {
  describeEstimate,
  estimateRenderMs,
  formatEta,
  formatRenderTime,
  remainingMs,
} from "@/lib/render-time";

/** How often to ask the server how a video render is getting on. */
const POLL_INTERVAL_MS = 1500;
/**
 * Give up after this long. Comfortably beyond the server's own
 * VIDEO_RENDER_TIMEOUT_MS (15 min default), so a job that dies server-side
 * reports its own failure rather than being cut off here first.
 */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Follow an asynchronous render to completion.
 *
 * Video jobs are queued, not rendered inline — POST /api/render answers 202
 * with a uid as soon as the job exists — so the finished file only shows up
 * later, on the job row.
 */
async function pollRenderJob(
  uid: string,
  onProgress: (progress: number) => void
): Promise<{ url: string; isVideo: boolean }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  onProgress(0);

  while (Date.now() < deadline) {
    const res = await fetch(`/api/renders/${uid}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Lost track of the render job");
    }
    const job = await res.json();

    if (job.status === "failed") {
      throw new Error(job.error || "Render failed");
    }
    if (job.status === "done") {
      const url = job.outputUrl || job.imageUrl;
      if (!url) throw new Error("Render finished but produced no file");
      onProgress(100);
      return { url, isVideo: job.outputKind === "video" };
    }

    onProgress(job.progress ?? 0);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("Timed out waiting for the render to finish");
}

export function PlaygroundContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const initialTemplate = searchParams.get("template") || "";

  const [selectedTemplate, setSelectedTemplate] = useState(initialTemplate);
  const [modifications, setModifications] = useState<Record<string, string>>(
    {}
  );
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<number | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  // A finished MP4 needs a <video>, not an <img>; and while it renders there is
  // a percentage to show, because video jobs are asynchronous.
  const [resultIsVideo, setResultIsVideo] = useState(false);
  const [videoProgress, setVideoProgress] = useState<number | null>(null);

  /**
   * Only what the user has explicitly changed on this screen.
   *
   * The Playground used to keep its own hardcoded png/90/1x, ignoring both the
   * project defaults and the template's — so the same template produced a
   * different file here than through the API. Now the fields show the resolved
   * settings (project → template → these overrides) and an edit records an
   * override for this render only.
   */
  const [overrides, setOverrides] = useState<OutputSettingsValue>({});
  const { defaults } = useOutputDefaults();

  // Fetch templates
  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: async () => {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error("Failed to fetch templates");
      return res.json();
    },
  });

  // Resolve selected templateId → internal UUID for API calls
  const selectedUuid = templates?.find(
    (t: any) => t.templateId === selectedTemplate
  )?.id;

  // Fetch selected template fields
  const { data: templateData } = useQuery({
    queryKey: ["template-fields", selectedUuid],
    queryFn: async () => {
      const res = await fetch(`/api/templates/${selectedUuid}`);
      if (!res.ok) throw new Error("Failed to fetch template");
      return res.json();
    },
    enabled: !!selectedUuid,
  });

  // Initialize modification fields when template changes
  useEffect(() => {
    if (templateData?.fields) {
      const mods: Record<string, string> = {};
      templateData.fields.forEach((field: any) => {
        mods[field.name] = field.defaultValue || "";
      });
      setModifications(mods);
    }
  }, [templateData]);

  // Set baseUrl after mount to avoid SSR hydration mismatch
  useEffect(() => {
    setBaseUrl(window.location.origin);
  }, []);

  // The settings this render will actually use: project defaults, then the
  // template's own outputDefaults, then anything changed on this screen —
  // exactly the chain the server applies (lib/output-settings.ts).
  const output = useMemo(
    () =>
      resolveOutputSettings(
        defaults,
        (templateData?.outputDefaults as PartialOutputSettings) || {},
        {
          ...(templateData?.videoDefaults?.fps
            ? { fps: templateData.videoDefaults.fps }
            : {}),
          ...(templateData?.videoDefaults?.durationSec
            ? { durationSec: templateData.videoDefaults.durationSec }
            : {}),
        },
        overrides as PartialOutputSettings
      ),
    [defaults, templateData, overrides]
  );

  const format = output.format;
  const isVideoFormat = format === "mp4";

  // MP4 is only offered for templates that actually contain a video layer —
  // the render rejects anything else with "Template does not contain video
  // layers". Switching to such a template with MP4 still selected would leave
  // the form in a state that can only fail, so fall back to PNG.
  const templateHasVideo = !!templateData?.hasVideo;
  useEffect(() => {
    if (format === "mp4" && templateData && !templateHasVideo) {
      setOverrides((prev) => ({ ...prev, format: "png" }));
    }
  }, [format, templateData, templateHasVideo]);

  // ---- Render time ---------------------------------------------------------
  // Estimated before the render, counted up during it, reported after it.
  const { data: renderStats } = useRenderStats();
  const estimate = estimateRenderMs(renderStats, {
    kind: isVideoFormat ? "video" : "image",
    templateId: selectedTemplate || null,
    width: templateData?.width,
    height: templateData?.height,
    scale: output.scale,
    fps: output.fps,
    durationSec: output.durationSec,
  });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastRenderMs, setLastRenderMs] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Generate mutation
  const generateMutation = useMutation({
    mutationFn: async () => {
      const modArray = Object.entries(modifications)
        .filter(([_, v]) => v)
        .map(([name, value]) => {
          const field = templateData?.fields?.find(
            (f: any) => f.name === name
          );
          if (field?.type === "image") {
            return { name, image_url: value };
          }
          if (field?.type === "shape") {
            return { name, fill: value };
          }
          return { name, text: value };
        });

      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: selectedTemplate,
          modifications: modArray,
          format: output.format,
          quality: output.quality,
          scale: output.scale,
          ...(isVideoFormat
            ? {
                videoQuality: output.videoQuality,
                fps: output.fps,
                ...(output.durationSec
                  ? { duration: output.durationSec }
                  : {}),
              }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate");
      }

      // Image renders come back finished. Video renders do not: the route
      // queues the job and answers 202 with a uid and no URL, so the result
      // has to be polled for. Treating that 202 as a finished render is why
      // choosing MP4 here produced nothing at all.
      if (res.status === 202 && data.uid) {
        return pollRenderJob(data.uid, setVideoProgress);
      }

      // A synchronous render can still have failed — the route reports that in
      // the body with a 200 — so it has to be checked rather than assumed.
      if (data.status === "failed" || !data.image_url) {
        throw new Error(data.error || "Render failed");
      }
      return { url: data.image_url, isVideo: false };
    },
    onMutate: () => {
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setLastRenderMs(null);
    },
    onSuccess: ({ url, isVideo }) => {
      const took = startedAtRef.current
        ? Date.now() - startedAtRef.current
        : null;
      setLastRenderMs(took);
      setGeneratedImage(url);
      setResultIsVideo(isVideo);
      setVideoProgress(null);
      setImageSize(null);
      // Fetch actual file size
      if (url) {
        fetch(url)
          .then((r) => r.blob())
          .then((blob) => setImageSize(blob.size))
          .catch(() => {});
      }
      // This render is now part of the history the estimates are built from.
      queryClient.invalidateQueries({ queryKey: ["render-stats"] });
      toast.success(
        `${isVideo ? "Video" : "Image"} generated${
          took ? ` in ${formatRenderTime(took)}` : ""
        }`
      );
    },
    onError: (err: Error) => {
      setVideoProgress(null);
      startedAtRef.current = null;
      toast.error(err.message || "Failed to generate");
    },
  });

  // Tick the elapsed-time readout while a render is in flight.
  useEffect(() => {
    if (!generateMutation.isPending) return;
    const id = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);
    return () => clearInterval(id);
  }, [generateMutation.isPending]);

  // Build the API request JSON for display
  const apiModifications = Object.entries(modifications)
    .filter(([_, v]) => v)
    .map(([name, value]) => {
      const field = templateData?.fields?.find((f: any) => f.name === name);
      if (field?.type === "image") return { name, image_url: value };
      if (field?.type === "shape") return { name, fill: value };
      return { name, text: value };
    });

  // MP4 is a different endpoint with a different body — /v1/images rejects
  // format "mp4" outright and points callers at /v1/videos, so showing the
  // image request for a video render would hand the user a failing snippet.
  const apiRequest = isVideoFormat
    ? {
        template_id: selectedTemplate || "tmpl_example",
        modifications: apiModifications,
        quality: output.videoQuality,
        fps: output.fps,
        scale: output.scale,
        ...(output.durationSec ? { duration: output.durationSec } : {}),
      }
    : {
        template_id: selectedTemplate || "tmpl_example",
        modifications: apiModifications,
        format: output.format,
        quality: output.quality,
        scale: output.scale,
      };

  const apiEndpoint = isVideoFormat ? "/v1/videos" : "/v1/images";

  const curlCommand = `curl -X POST ${baseUrl}${apiEndpoint} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(apiRequest, null, 2)}'`;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Playground</h1>
            <p className="text-muted-foreground">
              Test your templates and generate images interactively
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Controls */}
        <div className="space-y-6">
          {/* Template selector */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Template</CardTitle>
            </CardHeader>
            <CardContent>
              <Select
                value={selectedTemplate}
                onValueChange={setSelectedTemplate}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a template..." />
                </SelectTrigger>
                <SelectContent>
                  {templates?.map((t: any) => (
                    <SelectItem key={t.templateId} value={t.templateId}>
                      <div className="flex items-center gap-2">
                        <span>{t.name}</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {t.templateId}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Dynamic fields */}
          {templateData?.fields?.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Modifications</CardTitle>
                <CardDescription>
                  Fill in the dynamic fields for this template
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {templateData.fields.map((field: any) => (
                  <div key={field.name} className="space-y-1.5">
                    <Label className="flex items-center gap-2">
                      <span className="font-mono text-xs">{field.name}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {field.type}
                      </Badge>
                    </Label>
                    {field.type === "shape" ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={modifications[field.name] || field.defaultValue || "#000000"}
                          onChange={(e) =>
                            setModifications((prev) => ({
                              ...prev,
                              [field.name]: e.target.value,
                            }))
                          }
                          className="w-10 h-9 rounded border border-input cursor-pointer bg-transparent p-0.5"
                        />
                        <Input
                          value={modifications[field.name] || ""}
                          onChange={(e) =>
                            setModifications((prev) => ({
                              ...prev,
                              [field.name]: e.target.value,
                            }))
                          }
                          placeholder={field.defaultValue || "#000000"}
                          className="h-9 font-mono text-xs"
                        />
                      </div>
                    ) : (
                      <Input
                        value={modifications[field.name] || ""}
                        onChange={(e) =>
                          setModifications((prev) => ({
                            ...prev,
                            [field.name]: e.target.value,
                          }))
                        }
                        placeholder={
                          field.type === "image"
                            ? "https://example.com/image.png"
                            : field.defaultValue || "Enter value..."
                        }
                      />
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Output settings — the same fields, options and precedence as the
              editor and the Settings screen (components/output-settings-fields). */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Output Settings</CardTitle>
              <CardDescription>
                Starts from your global defaults
                {templateData?.outputDefaults
                  ? " and this template's overrides"
                  : ""}
                . Changes here apply to this render only.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <OutputSettingsFields
                value={{
                  format: output.format,
                  quality: output.quality,
                  scale: output.scale,
                  fps: output.fps,
                  videoQuality: output.videoQuality,
                  durationSec: overrides.durationSec ?? "",
                }}
                onChange={(patch) =>
                  setOverrides((prev) => ({ ...prev, ...patch }))
                }
                allowVideo={templateHasVideo}
              />

              <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                {/* Deliberately image-only: the estimate is bytes-per-pixel of a
                    single still, which says nothing useful about an encoded MP4. */}
                <span>
                  {templateData && !isVideoFormat
                    ? `Est. size: ${estimateOutputSizeLabel({
                        width: templateData.width || 1080,
                        height: templateData.height || 1350,
                        scale: output.scale,
                        format: output.format,
                        quality: output.quality,
                        design: templateData.designJson,
                      })}`
                    : ""}
                </span>
                <span
                  className="flex items-center gap-1"
                  title={describeEstimate(estimate)}
                >
                  <Timer className="h-3 w-3" />
                  Est. time: {formatEta(estimate.ms)}
                  {estimate.basis === "estimate" ? " (rough)" : ""}
                </span>
              </div>

              {Object.keys(overrides).length > 0 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  onClick={() => setOverrides({})}
                >
                  Reset to defaults
                </button>
              )}
            </CardContent>
          </Card>

          {/* Generate button */}
          <Button
            variant="accent"
            size="lg"
            className="w-full"
            onClick={() => generateMutation.mutate()}
            disabled={!selectedTemplate || generateMutation.isPending}
          >
            {generateMutation.isPending ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-5 w-5" />
            )}
            {generateMutation.isPending && videoProgress !== null
              ? `Rendering video… ${videoProgress}%`
              : isVideoFormat
              ? "Generate Video"
              : "Generate Image"}
          </Button>

          {/* Video renders take far longer than a still, so show the job's own
              progress rather than leaving a spinner sitting there for minutes. */}
          {generateMutation.isPending && videoProgress !== null && (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{ width: `${videoProgress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                Encoding frames — this can take a few minutes.
              </p>
            </div>
          )}

          {/* Elapsed vs. remaining. Once a video job reports real progress its
              own pace drives the countdown; before that (and for stills, which
              report nothing until they finish) the historical estimate does. */}
          {generateMutation.isPending && (
            <p className="text-xs text-muted-foreground text-center">
              {formatRenderTime(elapsedMs)} elapsed ·{" "}
              {formatEta(
                remainingMs({
                  elapsedMs,
                  progress: videoProgress,
                  estimateMs: estimate.ms,
                })
              )}{" "}
              left
            </p>
          )}
          {!generateMutation.isPending && lastRenderMs !== null && (
            <p className="text-xs text-muted-foreground text-center">
              Rendered in {formatRenderTime(lastRenderMs)}
            </p>
          )}
        </div>

        {/* Right: Preview & API */}
        <div className="space-y-6">
          {/* Preview */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Preview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="aspect-[4/3] bg-muted rounded-lg flex items-center justify-center overflow-hidden">
                {generatedImage ? (
                  // An MP4 in an <img> renders nothing at all, so the result
                  // has to be told apart from a still.
                  resultIsVideo ? (
                    <video
                      src={generatedImage}
                      controls
                      loop
                      playsInline
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <img
                      src={generatedImage}
                      alt="Generated"
                      className="w-full h-full object-contain"
                    />
                  )
                ) : (
                  <div className="text-center">
                    {isVideoFormat ? (
                      <Video className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                    ) : (
                      <FileImage className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                    )}
                    <p className="text-sm text-muted-foreground">
                      Generated {isVideoFormat ? "video" : "image"} will appear here
                    </p>
                  </div>
                )}
              </div>
              {generatedImage && (
                <div className="mt-3 space-y-2">
                  {imageSize !== null && (
                    <p className="text-xs text-muted-foreground">
                      Size:{" "}
                      {imageSize > 1024 * 1024
                        ? `${(imageSize / (1024 * 1024)).toFixed(2)} MB`
                        : `${Math.round(imageSize / 1024)} KB`}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        // Image URLs are root-relative; make absolute for copy.
                        const abs = generatedImage.startsWith("http")
                          ? generatedImage
                          : `${baseUrl}${generatedImage}`;
                        copyToClipboard(abs);
                        toast.success("URL copied");
                      }}
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy URL
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        try {
                          const res = await fetch(generatedImage);
                          const blob = await res.blob();
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `generated.${resultIsVideo ? "mp4" : format}`;
                          document.body.appendChild(a);
                          a.click();
                          a.remove();
                          URL.revokeObjectURL(url);
                        } catch {
                          toast.error("Download failed");
                        }
                      }}
                    >
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      Download
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* API Request */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">API Request</CardTitle>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    copyToClipboard(curlCommand);
                    toast.success("cURL command copied");
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="curl">
                <TabsList className="w-full">
                  <TabsTrigger value="curl" className="flex-1">
                    cURL
                  </TabsTrigger>
                  <TabsTrigger value="json" className="flex-1">
                    JSON
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="curl">
                  <pre className="p-3 bg-muted rounded-lg text-xs overflow-auto max-h-60 font-mono leading-relaxed">
                    {curlCommand}
                  </pre>
                </TabsContent>
                <TabsContent value="json">
                  <pre className="p-3 bg-muted rounded-lg text-xs overflow-auto max-h-60 font-mono leading-relaxed">
                    {JSON.stringify(apiRequest, null, 2)}
                  </pre>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
