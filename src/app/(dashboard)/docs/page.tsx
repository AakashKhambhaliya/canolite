"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
import { Copy, BookOpen } from "lucide-react";
import { copyToClipboard } from "@/lib/utils";

export default function DocsPage() {
  const [selectedTemplate, setSelectedTemplate] = useState("");

  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: async () => {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: templateData } = useQuery({
    queryKey: ["template-fields", selectedTemplate],
    queryFn: async () => {
      if (!selectedTemplate) return null;
      const template = templates?.find(
        (t: any) => t.templateId === selectedTemplate
      );
      if (!template) return null;
      const res = await fetch(`/api/templates/${template.id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedTemplate && !!templates,
  });

  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://your-domain.com";

  const exampleMods =
    templateData?.fields?.map((f: any) => {
      if (f.type === "image")
        return { name: f.name, image_url: "https://example.com/image.png" };
      return { name: f.name, text: f.defaultValue || `Your ${f.name}` };
    }) || [];

  const singleRequest = JSON.stringify(
    {
      template_id: selectedTemplate || "tmpl_abc123",
      modifications:
        exampleMods.length > 0
          ? exampleMods
          : [{ name: "headline", text: "Hello World" }],
      format: "png",
      quality: 90,
      scale: 2,
    },
    null,
    2
  );

  const batchRequest = JSON.stringify(
    {
      template_id: selectedTemplate || "tmpl_abc123",
      format: "jpg",
      quality: 85,
      scale: 2,
      items: [
        {
          modifications:
            exampleMods.length > 0
              ? exampleMods
              : [{ name: "headline", text: "Image 1" }],
        },
        {
          modifications:
            exampleMods.length > 0
              ? exampleMods.map((m: any) => ({
                  ...m,
                  text: m.text ? `${m.text} 2` : undefined,
                }))
              : [{ name: "headline", text: "Image 2" }],
        },
      ],
    },
    null,
    2
  );

  const endpoints = [
    {
      method: "POST",
      path: "/v1/images",
      desc: "Generate a single image",
    },
    {
      method: "GET",
      path: "/v1/images/:uid",
      desc: "Get render status & URL",
    },
    {
      method: "POST",
      path: "/v1/images/batch",
      desc: "Generate a batch of images",
    },
    {
      method: "GET",
      path: "/v1/templates",
      desc: "List all templates",
    },
    {
      method: "GET",
      path: "/v1/templates/:id",
      desc: "Get template details + fields",
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center">
            <BookOpen className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              API Documentation
            </h1>
            <p className="text-muted-foreground">
              Everything you need to integrate the render API
            </p>
          </div>
        </div>
      </div>

      {/* Template selector */}
      <Card className="mb-6">
        <CardContent className="pt-4">
          <div className="flex items-center gap-3">
            <Label className="shrink-0 text-sm font-medium">
              Generate docs for:
            </Label>
            <Select
              value={selectedTemplate}
              onValueChange={setSelectedTemplate}
            >
              <SelectTrigger className="max-w-sm">
                <SelectValue placeholder="Select a template..." />
              </SelectTrigger>
              <SelectContent>
                {templates?.map((t: any) => (
                  <SelectItem key={t.templateId} value={t.templateId}>
                    {t.name} ({t.templateId})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Auth */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Authentication</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            All API requests require a Bearer token in the Authorization header:
          </p>
          <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
            <code className="text-sm font-mono flex-1">
              Authorization: Bearer sk_live_your_api_key
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                copyToClipboard(
                  "Authorization: Bearer sk_live_your_api_key"
                );
                toast.success("Copied");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Endpoints list */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Endpoints</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {endpoints.map((ep, i) => (
            <div
              key={i}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <Badge
                variant={ep.method === "POST" ? "default" : "secondary"}
                className="w-14 justify-center text-xs font-mono"
              >
                {ep.method}
              </Badge>
              <code className="text-sm font-mono flex-1">
                {baseUrl}
                {ep.path}
              </code>
              <span className="text-sm text-muted-foreground hidden sm:block">
                {ep.desc}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Template fields */}
      {templateData?.fields?.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">
              Modifiable Fields — {templateData.name}
            </CardTitle>
            <CardDescription>
              These fields can be overridden via the API
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted">
                    <th className="px-4 py-2 text-left font-medium">
                      Name
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      Type
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      Default
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {templateData.fields.map((field: any) => (
                    <tr key={field.name} className="border-t">
                      <td className="px-4 py-2 font-mono text-xs">
                        {field.name}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-[10px]">
                          {field.type}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground text-xs truncate max-w-[200px]">
                        {field.defaultValue || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Code examples */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Examples</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="single">
            <TabsList>
              <TabsTrigger value="single">Single Image</TabsTrigger>
              <TabsTrigger value="batch">Batch</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
            </TabsList>

            <TabsContent value="single" className="relative">
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-2 top-2"
                onClick={() => {
                  copyToClipboard(singleRequest);
                  toast.success("Copied");
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <pre className="p-4 bg-muted rounded-lg text-xs overflow-auto max-h-80 font-mono leading-relaxed">
                {`POST ${baseUrl}/v1/images\n\n${singleRequest}`}
              </pre>
            </TabsContent>

            <TabsContent value="batch" className="relative">
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-2 top-2"
                onClick={() => {
                  copyToClipboard(batchRequest);
                  toast.success("Copied");
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <pre className="p-4 bg-muted rounded-lg text-xs overflow-auto max-h-80 font-mono leading-relaxed">
                {`POST ${baseUrl}/v1/images/batch\n\n${batchRequest}`}
              </pre>
            </TabsContent>

            <TabsContent value="curl" className="relative">
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-2 top-2"
                onClick={() => {
                  const curl = `curl -X POST ${baseUrl}/v1/images \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${singleRequest}'`;
                  copyToClipboard(curl);
                  toast.success("Copied");
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <pre className="p-4 bg-muted rounded-lg text-xs overflow-auto max-h-80 font-mono leading-relaxed">
                {`curl -X POST ${baseUrl}/v1/images \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${singleRequest}'`}
              </pre>
            </TabsContent>
          </Tabs>

          {/* Response modes */}
          <div className="mt-6 space-y-3 text-sm">
            <h4 className="font-medium">Response modes</h4>
            <p className="text-muted-foreground">
              By default the request is{" "}
              <span className="font-medium text-foreground">asynchronous</span>:
              it returns <code className="font-mono text-xs">202</code> with a{" "}
              <code className="font-mono text-xs">uid</code>, and you poll{" "}
              <code className="font-mono text-xs">
                GET {baseUrl}/v1/images/&#123;uid&#125;
              </code>{" "}
              until <code className="font-mono text-xs">status</code> is{" "}
              <code className="font-mono text-xs">done</code>.
            </p>
            <p className="text-muted-foreground">
              To skip polling, add{" "}
              <code className="font-mono text-xs">"synchronous": true</code> to
              the request body. The API then waits for the render and returns{" "}
              <code className="font-mono text-xs">200</code> with{" "}
              <code className="font-mono text-xs">image_url</code> directly (or{" "}
              <code className="font-mono text-xs">422</code> with an{" "}
              <code className="font-mono text-xs">error</code> if it fails).
            </p>
            <pre className="p-4 bg-muted rounded-lg text-xs overflow-auto font-mono leading-relaxed">
              {`POST ${baseUrl}/v1/images\n\n` +
                JSON.stringify(
                  {
                    template_id: selectedTemplate || "tmpl_abc123",
                    synchronous: true,
                    modifications:
                      exampleMods.length > 0
                        ? exampleMods
                        : [{ name: "headline", text: "Hello World" }],
                    format: "png",
                  },
                  null,
                  2
                ) +
                `\n\n// 200 response\n` +
                JSON.stringify(
                  {
                    uid: "img_abc123",
                    status: "done",
                    image_url: `${baseUrl}/storage/renders/img_abc123.png`,
                    duration_ms: 1840,
                  },
                  null,
                  2
                )}
            </pre>
            <p className="text-xs text-muted-foreground">
              Note: synchronous requests are best for single images. For large
              batches use the async flow or{" "}
              <code className="font-mono text-xs">/v1/images/batch</code> so the
              connection isn&apos;t held open.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
