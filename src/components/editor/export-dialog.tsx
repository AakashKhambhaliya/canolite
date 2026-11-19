"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { StudioDialog } from "./studio/chrome";
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
  validationIssue: string | null;
  saving: boolean;
  onExport: () => Promise<void>;
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
  validationIssue,
  saving,
  onExport,
}: ExportDialogProps) {
  const [busy, setBusy] = useState(false);
  const issue =
    validationIssue ||
    (exportFormat === "mp4" &&
    exportDuration !== "" &&
    (!Number.isFinite(exportDuration) ||
      exportDuration < MIN_DURATION_SEC ||
      exportDuration > MAX_DURATION_SEC)
      ? `Duration must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds.`
      : null);
  return (
    <StudioDialog
      open={open}
      close={() => {
        if (!busy) onOpenChange(false);
      }}
      title="Export design"
      description="Choose a file format and size for your artboard."
      kicker="STUDIO OUTPUT"
    >
      <div className="sl-form" aria-busy={busy}>
        <label>File format</label>
        <div className="sl-format-grid" role="group" aria-label="File format">
          {[...IMAGE_FORMATS, "svg", ...(canvasHasVideo ? ["mp4"] : [])].map(
            (f) => (
              <button
                key={f}
                aria-pressed={exportFormat === f}
                onClick={() => setExportFormat(f)}
              >
                {f.toUpperCase()}
              </button>
            ),
          )}
        </div>
        {(exportFormat === "jpg" || exportFormat === "webp") && (
          <label>
            <span className="sl-label-end">
              Image quality <small>{exportQuality}%</small>
            </span>
            <input
              aria-label="Image quality"
              type="range"
              value={exportQuality}
              min={10}
              max={100}
              step={5}
              onChange={(e) => setExportQuality(Number(e.target.value))}
            />
          </label>
        )}
        {exportFormat === "mp4" && (
          <>
            <label>Frame rate</label>
            <div className="sl-format-grid">
              {FPS_PRESETS.map((f) => (
                <button
                  key={f}
                  aria-pressed={exportFps === f}
                  onClick={() => setExportFps(f)}
                >
                  {f} fps
                </button>
              ))}
            </div>
            <div className="sl-2cols">
              <label>
                Duration (seconds)
                <input
                  type="number"
                  min={MIN_DURATION_SEC}
                  max={MAX_DURATION_SEC}
                  step={0.1}
                  placeholder="Automatic"
                  value={exportDuration}
                  onChange={(e) =>
                    setExportDuration(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                />
              </label>
              <label>
                Video quality
                <select
                  value={exportVideoQuality}
                  onChange={(e) =>
                    setExportVideoQuality(
                      e.target.value as typeof exportVideoQuality,
                    )
                  }
                >
                  {VIDEO_QUALITY_PRESETS.map((v) => (
                    <option key={v} value={v}>
                      {VIDEO_QUALITY_LABELS[v]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </>
        )}
        {exportFormat !== "svg" && (
          <>
            <label>Export scale</label>
            <div
              className="sl-format-grid"
              role="group"
              aria-label="Export scale"
            >
              {SCALE_OPTIONS.map((s) => (
                <button
                  key={s}
                  aria-pressed={exportScale === s}
                  onClick={() => setExportScale(s)}
                >
                  {s}×
                </button>
              ))}
            </div>
          </>
        )}
        <div className="sl-setting-summary">
          <strong>{exportFormat.toUpperCase()}</strong>
          <span>
            {exportFormat === "svg"
              ? "Scalable vector"
              : `${templateWidth * exportScale} × ${templateHeight * exportScale} px`}
          </span>
        </div>
        {(sizeLabel || estimateLabel) && (
          <p className="sl-fine" title={estimateTitle}>
            {sizeLabel
              ? `Estimated file size: ${sizeLabel}`
              : `Estimated render time: ${estimateLabel}`}
          </p>
        )}
        {issue && (
          <p className="sl-export-issue" role="alert">
            {issue}
          </p>
        )}
        <button
          className="sl-primary sl-fill"
          disabled={busy || saving || !!issue}
          onClick={async () => {
            setBusy(true);
            try {
              await onExport();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <Loader2 className="animate-spin" size={16} />
          ) : (
            <Download size={16} />
          )}
          Export {exportFormat.toUpperCase()}
        </button>
      </div>
    </StudioDialog>
  );
}
