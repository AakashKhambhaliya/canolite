"use client";

import type React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  FPS_PRESETS,
  IMAGE_FORMATS,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  SCALE_OPTIONS,
  VIDEO_QUALITY_LABELS,
  VIDEO_QUALITY_PRESETS,
} from "@/lib/output-settings";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exportFormat: string;
  setExportFormat: (format: string) => void;
  exportQuality: number;
  setExportQuality: (quality: number) => void;
  exportScale: number;
  setExportScale: (scale: number) => void;
  exportFps: number;
  setExportFps: (fps: number) => void;
  exportDuration: number | "";
  setExportDuration: (duration: number | "") => void;
  exportVideoQuality: "high" | "balanced" | "small";
  setExportVideoQuality: (quality: "high" | "balanced" | "small") => void;
  canvasHasVideo: boolean;
  templateWidth: number;
  templateHeight: number;
  /** "~6s" for an MP4 export; null when the export happens locally. */
  estimateLabel?: string | null;
  /** Hover text explaining where the estimate comes from. */
  estimateTitle?: string;
  /** "~1.2 MB", or null for formats the estimator can't speak to. */
  sizeLabel?: string | null;
  onExport: () => void;
}

export function ExportDialog({
  open,
  onOpenChange,
  exportFormat,
  setExportFormat,
  exportQuality,
  setExportQuality,
  exportScale,
  setExportScale,
  exportFps,
  setExportFps,
  exportDuration,
  setExportDuration,
  exportVideoQuality,
  setExportVideoQuality,
  canvasHasVideo,
  templateWidth,
  templateHeight,
  estimateLabel,
  estimateTitle,
  sizeLabel,
  onExport,
}: ExportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[400px] border-white/10"
        style={{
          backgroundColor: "#14171c",
          color: "#e6e8ec",
          "--border": "220 15% 20%",
          "--background": "220 18% 10%",
          "--foreground": "220 10% 92%",
          "--accent": "220 15% 16%",
          "--accent-foreground": "220 10% 92%",
          "--popover": "220 18% 10%",
          "--popover-foreground": "220 10% 92%",
          "--muted": "220 15% 16%",
          "--muted-foreground": "220 10% 65%",
          "--input": "220 15% 20%",
        } as React.CSSProperties}
      >
        <DialogHeader>
          <DialogTitle style={{ color: "#e6e8ec" }}>Export Image</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Format */}
          <div className="space-y-1.5">
            <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
              Format
            </Label>
            <div className="grid grid-cols-4 gap-2">
              {/* Format names match the rest of the app (JPG, not JPEG — see
                  lib/output-settings.ts). SVG is export-only: it is drawn from
                  the canvas here and the render API has no equivalent. */}
              {([...IMAGE_FORMATS, "svg", ...(canvasHasVideo ? ["mp4" as const] : [])] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setExportFormat(fmt)}
                  className={cn(
                    "h-9 rounded-lg text-xs font-medium uppercase transition-colors",
                    exportFormat === fmt
                      ? "bg-[#2f6fde] text-white"
                      : "bg-[#1f232a] hover:bg-[#23262c]"
                  )}
                  style={exportFormat !== fmt ? { color: "#c4c9d2" } : undefined}
                >
                  {fmt}
                </button>
              ))}
            </div>
          </div>

          {/* Quality (only for the lossy image formats) */}
          {(exportFormat === "jpg" || exportFormat === "webp") && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                  Quality
                </Label>
                <span className="text-xs font-mono" style={{ color: "#8b919c" }}>
                  {exportQuality}%
                </span>
              </div>
              <Slider
                value={[exportQuality]}
                onValueChange={([v]) => setExportQuality(v)}
                min={10}
                max={100}
                step={5}
              />
            </div>
          )}

          {exportFormat === "mp4" && (
            <div className="space-y-3 rounded-lg border border-white/[0.08] p-3">
              <div className="grid grid-cols-3 gap-2">
                {FPS_PRESETS.map((fps) => (
                  <button
                    key={fps}
                    onClick={() => setExportFps(fps)}
                    className={cn(
                      "h-8 rounded-lg text-xs font-medium transition-colors",
                      exportFps === fps ? "bg-[#2f6fde] text-white" : "bg-[#1f232a] hover:bg-[#23262c]"
                    )}
                  >
                    {fps} fps
                  </button>
                ))}
              </div>
              <Input
                type="number"
                min={MIN_DURATION_SEC}
                max={MAX_DURATION_SEC}
                step={0.1}
                placeholder="Auto duration"
                value={exportDuration}
                onChange={(e) => setExportDuration(e.target.value === "" ? "" : Number(e.target.value))}
                className="h-8 bg-[#121418] border-white/[0.08] text-xs"
              />
              <Select value={exportVideoQuality} onValueChange={(v: any) => setExportVideoQuality(v)}>
                <SelectTrigger className="h-8 bg-[#121418] border-white/[0.08] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIDEO_QUALITY_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {VIDEO_QUALITY_LABELS[preset]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Scale (not for SVG) */}
          {exportFormat !== "svg" && (
            <div className="space-y-1.5">
              <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                Scale
              </Label>
              <div className="grid grid-cols-4 gap-2">
                {SCALE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setExportScale(s)}
                    className={cn(
                      "h-9 rounded-lg text-xs font-medium transition-colors",
                      exportScale === s
                        ? "bg-[#2f6fde] text-white"
                        : "bg-[#1f232a] hover:bg-[#23262c]"
                    )}
                    style={exportScale !== s ? { color: "#c4c9d2" } : undefined}
                  >
                    {s}x
                  </button>
                ))}
              </div>
              <p className="text-[10px]" style={{ color: "#8b919c" }}>
                Output: {templateWidth * exportScale} × {templateHeight * exportScale}px
              </p>
            </div>
          )}

          {/* Estimates. MP4 is rendered on the server, so it gets a time
              estimate from this project's measured render history; the other
              formats are drawn from the canvas here and finish immediately. */}
          {(sizeLabel || estimateLabel) && (
            <div
              className="flex items-center justify-between text-[10px]"
              style={{ color: "#8b919c" }}
            >
              <span>{sizeLabel ? `Est. size: ${sizeLabel}` : ""}</span>
              {estimateLabel && (
                <span title={estimateTitle}>Est. time: {estimateLabel}</span>
              )}
            </div>
          )}

          {/* Export button */}
          <Button
            onClick={onExport}
            className="w-full bg-[#2f6fde] hover:bg-[#2561c7] text-white"
          >
            <Download className="mr-2 h-4 w-4" />
            Export {exportFormat.toUpperCase()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
