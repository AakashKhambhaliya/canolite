"use client";

import { useMemo, useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  Upload,
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  Check,
  Loader2,
  AlertCircle,
  Table,
  Zap,
  Timer,
} from "lucide-react";
import {
  OutputSettingsFields,
  type OutputSettingsValue,
} from "@/components/output-settings-fields";
import {
  resolveOutputSettings,
  type PartialOutputSettings,
} from "@/lib/output-settings";
import { useOutputDefaults } from "@/hooks/use-output-settings";
import { useRenderStats } from "@/hooks/use-render-stats";
import {
  describeEstimate,
  estimateBatchMs,
  estimateRenderMs,
  formatEta,
} from "@/lib/render-time";

/**
 * Parse CSV text handling quoted fields (commas, newlines, escaped quotes).
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell.trim());
        cell = "";
      } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
        row.push(cell.trim());
        if (row.some((c) => c)) rows.push(row);
        row = [];
        cell = "";
        if (ch === "\r") i++; // skip \r\n
      } else {
        cell += ch;
      }
    }
  }
  // Last cell/row
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);

  return rows;
}

type Step = "template" | "upload" | "mapping" | "preview" | "generate";

export default function BulkPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("template");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  // Same universal chain as everywhere else: global defaults, then the
  // template's own overrides, then anything changed for this batch.
  const [overrides, setOverrides] = useState<OutputSettingsValue>({});
  const { defaults } = useOutputDefaults();

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
      const template = templates?.find((t: any) => t.templateId === selectedTemplate);
      if (!template) return null;
      const res = await fetch(`/api/templates/${template.id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedTemplate && !!templates,
  });

  const output = useMemo(
    () =>
      resolveOutputSettings(
        defaults,
        (templateData?.outputDefaults as PartialOutputSettings) || {},
        overrides as PartialOutputSettings
      ),
    [defaults, templateData, overrides]
  );

  // How long the whole batch is likely to take, at the server's render
  // concurrency — the number people actually want before queuing 500 images.
  const rowCount = Math.max(0, csvData.length - 1);
  const { data: renderStats } = useRenderStats();
  const perRenderEstimate = estimateRenderMs(renderStats, {
    kind: "image",
    templateId: selectedTemplate || null,
    width: templateData?.width,
    height: templateData?.height,
    scale: output.scale,
  });
  const batchEstimateMs = estimateBatchMs(
    perRenderEstimate.ms,
    rowCount,
    renderStats?.concurrency?.image
  );

  const batchMutation = useMutation({
    mutationFn: async () => {
      const items = csvData.slice(1).map((row) => {
        const mods: any[] = [];
        for (const [fieldName, csvCol] of Object.entries(fieldMapping)) {
          if (!csvCol || csvCol === "__skip__") continue;
          const colIdx = csvHeaders.indexOf(csvCol);
          if (colIdx === -1) continue;
          const field = templateData?.fields?.find((f: any) => f.name === fieldName);
          const value = row[colIdx] || "";
          if (field?.type === "image") {
            mods.push({ name: fieldName, image_url: value });
          } else if (field?.type === "shape") {
            mods.push({ name: fieldName, fill: value });
          } else {
            mods.push({ name: fieldName, text: value });
          }
        }
        return { modifications: mods };
      });

      const res = await fetch("/api/render/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: selectedTemplate,
          format: output.format,
          quality: output.quality,
          scale: output.scale,
          items,
        }),
      });
      if (!res.ok) throw new Error("Failed to create batch");
      return res.json();
    },
    onSuccess: (data) => {
      toast.success(`Batch of ${data.count || csvData.length - 1} renders queued!`);
      router.push(
        data.batch_uid ? `/renders?batch=${data.batch_uid}` : "/renders"
      );
    },
    onError: () => {
      toast.error("Failed to create batch");
    },
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const parsed = parseCSV(text);
        if (parsed.length < 2) {
          toast.error("CSV must have at least a header and one data row");
          return;
        }
        setCsvHeaders(parsed[0]);
        setCsvData(parsed);

        // Auto-map by matching header names to field names
        if (templateData?.fields) {
          const autoMap: Record<string, string> = {};
          templateData.fields.forEach((field: any) => {
            const match = parsed[0].find(
              (h) => h.toLowerCase() === field.name.toLowerCase()
            );
            if (match) autoMap[field.name] = match;
          });
          setFieldMapping(autoMap);
        }

        setStep("mapping");
      } catch (err) {
        toast.error("Failed to parse CSV file");
        console.error("CSV parse error:", err);
      }
    };
    reader.readAsText(file);
  };

  const steps: { id: Step; label: string; num: number }[] = [
    { id: "template", label: "Template", num: 1 },
    { id: "upload", label: "Upload CSV", num: 2 },
    { id: "mapping", label: "Map Fields", num: 3 },
    { id: "preview", label: "Preview", num: 4 },
    { id: "generate", label: "Generate", num: 5 },
  ];

  const stepIdx = steps.findIndex((s) => s.id === step);

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <FileSpreadsheet className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Bulk from CSV</h1>
            <p className="text-muted-foreground">
              Generate hundreds of images from a spreadsheet
            </p>
          </div>
        </div>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-8">
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i <= stepIdx
                  ? "bg-blue-600 text-white"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {i < stepIdx ? <Check className="h-4 w-4" /> : s.num}
            </div>
            <span
              className={`text-sm hidden sm:inline ${
                i <= stepIdx ? "font-medium" : "text-muted-foreground"
              }`}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div className="w-8 h-px bg-border" />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      {step === "template" && (
        <Card>
          <CardHeader>
            <CardTitle>Select Template</CardTitle>
            <CardDescription>
              Choose the template to use for all images in the batch
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a template..." />
              </SelectTrigger>
              <SelectContent>
                {templates?.map((t: any) => (
                  <SelectItem key={t.templateId} value={t.templateId}>
                    {t.name} ({t.templateId})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex justify-end">
              <Button
                variant="accent"
                disabled={!selectedTemplate}
                onClick={() => setStep("upload")}
              >
                Next
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle>Upload CSV</CardTitle>
            <CardDescription>
              Upload a CSV file with columns matching your template fields
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium mb-1">Click to upload CSV</p>
              <p className="text-sm text-muted-foreground">
                or drag and drop your file here
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileUpload}
            />
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("template")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "mapping" && (
        <Card>
          <CardHeader>
            <CardTitle>Map Columns to Fields</CardTitle>
            <CardDescription>
              Match your CSV columns to template fields. Auto-matched columns
              are pre-selected.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {templateData?.fields?.map((field: any) => (
              <div
                key={field.name}
                className="flex items-center gap-4"
              >
                <div className="flex-1">
                  <Label className="font-mono text-xs">{field.name}</Label>
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {field.type}
                  </Badge>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <Select
                    value={fieldMapping[field.name] || ""}
                    onValueChange={(v) =>
                      setFieldMapping((prev) => ({ ...prev, [field.name]: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select column..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__skip__">— Skip —</SelectItem>
                      {csvHeaders.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep("upload")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button variant="accent" onClick={() => setStep("preview")}>
                Next
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "preview" && (
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              {csvData.length - 1} rows will generate {csvData.length - 1} images
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border overflow-auto max-h-64">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted">
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    {Object.entries(fieldMapping)
                      .filter(([_, v]) => v)
                      .map(([field]) => (
                        <th key={field} className="px-3 py-2 text-left font-medium font-mono">
                          {field}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {csvData.slice(1, 11).map((row, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                      {Object.entries(fieldMapping)
                        .filter(([_, v]) => v)
                        .map(([field, col]) => {
                          const colIdx = csvHeaders.indexOf(col);
                          return (
                            <td key={field} className="px-3 py-2 max-w-[200px] truncate">
                              {row[colIdx] || "—"}
                            </td>
                          );
                        })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {csvData.length > 11 && (
              <p className="text-xs text-muted-foreground text-center">
                Showing first 10 of {csvData.length - 1} rows
              </p>
            )}

            {/* Output settings — the shared fields, starting from the global
                defaults and this template's overrides. */}
            <div className="pt-2 space-y-3">
              <OutputSettingsFields
                value={{
                  format: output.format,
                  quality: output.quality,
                  scale: output.scale,
                }}
                onChange={(patch) =>
                  setOverrides((prev) => ({ ...prev, ...patch }))
                }
              />
              <p
                className="text-xs text-muted-foreground flex items-center gap-1.5"
                title={describeEstimate(perRenderEstimate)}
              >
                <Timer className="h-3.5 w-3.5" />
                Est. rendering time: {formatEta(batchEstimateMs)} for {rowCount}{" "}
                image{rowCount === 1 ? "" : "s"} ({formatEta(
                  perRenderEstimate.ms
                )}{" "}
                each
                {renderStats?.concurrency?.image
                  ? `, ${renderStats.concurrency.image} at a time`
                  : ""}
                )
              </p>
            </div>

            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep("mapping")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button
                variant="accent"
                onClick={() => batchMutation.mutate()}
                disabled={batchMutation.isPending}
              >
                {batchMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="mr-2 h-4 w-4" />
                )}
                Generate {csvData.length - 1} Images
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
