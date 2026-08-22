"use client";
/* eslint-disable @next/next/no-img-element */

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
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
} from "lucide-react";
import { copyToClipboard } from "@/lib/utils";

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
  const searchParams = useSearchParams();
  const initialTemplate = searchParams.get("template") || "";

  const [selectedTemplate, setSelectedTemplate] = useState(initialTemplate);
  const [modifications, setModifications] = useState<Record<string, string>>(
    {}
  );
  const [format, setFormat] = useState("png");
  const [quality, setQuality] = useState(90);
  const [scale, setScale] = useState(1);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<number | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  // MP4-only output settings. The image `quality` number means nothing to the
  // encoder, which takes a CRF preset instead.
  const [videoQuality, setVideoQuality] = useState("balanced");
  const [fps, setFps] = useState(30);
  const [duration, setDuration] = useState<number | "">("");
  // A finished MP4 needs a <video>, not an <img>; and while it renders there is
  // a percentage to show, because video jobs are asynchronous.
  const [resultIsVideo, setResultIsVideo] = useState(false);
  const [videoProgress, setVideoProgress] = useState<number | null>(null);

  const isVideoFormat = format === "mp4";

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

  // MP4 is only offered for templates that actually contain a video layer —
  // the render rejects anything else with "Template does not contain video
  // layers". Switching to such a template with MP4 still selected would leave
  // the form in a state that can only fail, so fall back to PNG.
  const templateHasVideo = !!templateData?.hasVideo;
  useEffect(() => {
    if (format === "mp4" && templateData && !templateHasVideo) setFormat("png");
  }, [format, templateData, templateHasVideo]);

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
          format,
          quality,
          scale,
          ...(isVideoFormat
            ? {
                videoQuality,
                fps,
                ...(duration !== "" ? { duration: Number(duration) } : {}),
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
    onSuccess: ({ url, isVideo }) => {
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
      toast.success(isVideo ? "Video generated!" : "Image generated!");
    },
    onError: (err: Error) => {
      setVideoProgress(null);
      toast.error(err.message || "Failed to generate");
    },
  });

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
        quality: videoQuality,
        fps,
        ...(duration !== "" ? { duration: Number(duration) } : {}),
      }
    : {
        template_id: selectedTemplate || "tmpl_example",
        modifications: apiModifications,
        format,
        quality,
        scale,
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

          {/* Output settings */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Output Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Format</Label>
                  <Select value={format} onValueChange={setFormat}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="png">PNG</SelectItem>
                      <SelectItem value="jpg">JPG</SelectItem>
                      <SelectItem value="webp">WebP</SelectItem>
                      {/* Only for templates with a video layer — the render
                          refuses MP4 for anything else. Matches the editor's
                          export dialog, which gates it the same way. */}
                      {templateHasVideo && (
                        <SelectItem value="mp4">MP4</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Quality</Label>
                  {isVideoFormat ? (
                    // The encoder takes a CRF preset, not the 1-100 number the
                    // image formats use — passing that number through would be
                    // read as a CRF and quietly wreck the output.
                    <Select value={videoQuality} onValueChange={setVideoQuality}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="balanced">Balanced</SelectItem>
                        <SelectItem value="small">Small</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      type="number"
                      value={quality}
                      onChange={(e) => setQuality(Number(e.target.value))}
                      min={1}
                      max={100}
                      className="h-9"
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Scale</Label>
                  <Select
                    value={String(scale)}
                    onValueChange={(v) => setScale(Number(v))}
                  >
                    <SelectTrigger className="h-9">
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

              {isVideoFormat && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Frame rate</Label>
                    <Input
                      type="number"
                      value={fps}
                      onChange={(e) => setFps(Number(e.target.value))}
                      min={1}
                      max={60}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Duration (s)</Label>
                    <Input
                      type="number"
                      value={duration}
                      onChange={(e) =>
                        setDuration(e.target.value === "" ? "" : Number(e.target.value))
                      }
                      min={1}
                      max={120}
                      placeholder="Auto"
                      className="h-9"
                    />
                  </div>
                </div>
              )}

              {/* Deliberately image-only: this estimate is bytes-per-pixel of a
                  single still, which says nothing useful about an encoded MP4. */}
              {templateData && !isVideoFormat && (
                <p className="text-xs text-muted-foreground pt-3">
                  Est. size:{" "}
                  {(() => {
                    const pixels = (templateData.width || 1080) * scale * (templateData.height || 1350) * scale;
                    
                    // Calculate complexity from layers
                    let complexityScore = 1;
                    if (templateData?.designJson?.objects) {
                      templateData.designJson.objects.forEach((obj: any) => {
                        if (obj.type === 'image') complexityScore += 1.5;
                        else if (obj.type === 'i-text' || obj.type === 'textbox') complexityScore += 0.2;
                        else complexityScore += 0.1;
                      });
                    }
                    const multiplier = Math.min(Math.max(complexityScore, 1), 6);

                    const baseBytesPerPx =
                      format === "png" 
                        ? 0.05 
                        : format === "webp" 
                          ? 0.005 + (quality / 100) * 0.01 
                          : 0.002 + (quality / 100) * 0.015;

                    const sizeBytes = Math.round(pixels * baseBytesPerPx * multiplier);
                    return sizeBytes > 1024 * 1024
                      ? `~${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                      : `~${Math.round(sizeBytes / 1024)} KB`;
                  })()}
                </p>
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
