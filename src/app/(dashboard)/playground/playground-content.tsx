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
} from "lucide-react";
import { copyToClipboard } from "@/lib/utils";

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
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to generate");
      }
      return res.json();
    },
    onSuccess: (data) => {
      const url = data.image_url || data.imageUrl;
      setGeneratedImage(url);
      setImageSize(null);
      // Fetch actual file size
      if (url) {
        fetch(url)
          .then((r) => r.blob())
          .then((blob) => setImageSize(blob.size))
          .catch(() => {});
      }
      toast.success("Image generated!");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to generate image");
    },
  });

  // Build the API request JSON for display
  const apiRequest = {
    template_id: selectedTemplate || "tmpl_example",
    modifications: Object.entries(modifications)
      .filter(([_, v]) => v)
      .map(([name, value]) => {
        const field = templateData?.fields?.find(
          (f: any) => f.name === name
        );
        if (field?.type === "image") return { name, image_url: value };
        if (field?.type === "shape") return { name, fill: value };
        return { name, text: value };
      }),
    format,
    quality,
    scale,
  };


  const curlCommand = `curl -X POST ${baseUrl}/v1/images \\
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
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Quality</Label>
                  <Input
                    type="number"
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                    min={1}
                    max={100}
                    className="h-9"
                  />
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
              {templateData && (
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
            Generate Image
          </Button>
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
                  <img
                    src={generatedImage}
                    alt="Generated"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-center">
                    <FileImage className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">
                      Generated image will appear here
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
                          a.download = `generated.${format}`;
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
