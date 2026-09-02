"use client";

/**
 * The output settings form — the one used by Settings, the editor's Output
 * popover, the editor's Export dialog and the Playground.
 *
 * Each of those screens used to hand-roll its own fields, which is how they
 * ended up disagreeing (scale to 3 here, to 4 there; quality meaning a 1-100
 * number for images and a preset for MP4 in only some of them). The option
 * lists come from lib/output-settings.ts, so a change there reaches every
 * surface at once.
 *
 * Two modes:
 *  - `allowInherit` (template/per-render level): an empty field means "use the
 *    global default", and the placeholder shows what that default currently is.
 *  - default (Settings): every field holds a concrete value.
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  FORMAT_LABELS,
  IMAGE_FORMATS,
  MAX_DURATION_SEC,
  MAX_FPS,
  MAX_QUALITY,
  MIN_DURATION_SEC,
  MIN_FPS,
  MIN_QUALITY,
  SCALE_OPTIONS,
  VIDEO_QUALITY_LABELS,
  VIDEO_QUALITY_PRESETS,
  type OutputFormat,
  type OutputSettings,
} from "@/lib/output-settings";

/** Sentinel for "inherit the global default" inside a <Select>. */
const INHERIT = "__default__";

export interface OutputSettingsValue {
  format?: string;
  quality?: number | "";
  scale?: number | "";
  fps?: number | "";
  videoQuality?: string;
  durationSec?: number | "";
}

export interface OutputSettingsFieldsProps {
  value: OutputSettingsValue;
  onChange: (patch: OutputSettingsValue) => void;
  /** What blank fields fall back to — shown in the placeholders. */
  inherited?: OutputSettings;
  /** Offer "Use global default" and allow blank values. */
  allowInherit?: boolean;
  /** Offer MP4 as a format (templates with a video layer). */
  allowVideo?: boolean;
  /** When to show fps / duration / video quality. */
  videoFields?: "auto" | "always" | "never";
  /**
   * Whether the clip-length field belongs here. It is a per-render choice (the
   * default is "as long as the timeline needs"), so the global Settings screen
   * leaves it out.
   */
  showDuration?: boolean;
  /** Editor chrome (dark popover) vs. dashboard cards. */
  dark?: boolean;
  className?: string;
}

export function OutputSettingsFields({
  value,
  onChange,
  inherited,
  allowInherit = false,
  allowVideo = false,
  videoFields = "auto",
  showDuration = true,
  dark = false,
  className,
}: OutputSettingsFieldsProps) {
  const effectiveFormat = (value.format ||
    inherited?.format ||
    "png") as OutputFormat;
  const isVideo = effectiveFormat === "mp4";
  const showVideo =
    videoFields === "always" ||
    (videoFields === "auto" && isVideo && allowVideo);
  /**
   * When MP4 is the chosen format the "Quality" slot means the encoder preset,
   * so it replaces the 1-100 number. In "always" mode (the Settings screen,
   * which defines defaults for images AND video at once) both need a control,
   * so the preset moves down to the video row instead.
   */
  const topQualityIsPreset = isVideo && videoFields !== "always";

  const control = dark
    ? "h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]"
    : "h-9";
  const menu = dark ? "bg-[#14171c] border-white/[0.1] text-[#e6e8ec]" : "";
  const labelClass = dark ? "text-[11px] text-[#c4c9d2]" : "text-xs";

  const formats: OutputFormat[] = allowVideo
    ? [...IMAGE_FORMATS, "mp4"]
    : [...IMAGE_FORMATS];

  const inheritLabel = (label: string | number | undefined) =>
    label === undefined ? "Use global default" : `Default (${label})`;

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid grid-cols-3 gap-3">
        {/* Format */}
        <div className="space-y-1.5">
          <Label className={labelClass}>Format</Label>
          <Select
            value={value.format || (allowInherit ? INHERIT : effectiveFormat)}
            onValueChange={(v) =>
              onChange({ format: v === INHERIT ? "" : v })
            }
          >
            <SelectTrigger className={control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={menu}>
              {allowInherit && (
                <SelectItem value={INHERIT}>
                  {inheritLabel(
                    inherited ? FORMAT_LABELS[inherited.format] : undefined
                  )}
                </SelectItem>
              )}
              {formats.map((fmt) => (
                <SelectItem key={fmt} value={fmt}>
                  {FORMAT_LABELS[fmt]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Quality — a 1-100 number for images, a preset for MP4 */}
        <div className="space-y-1.5">
          <Label className={labelClass}>Quality</Label>
          {topQualityIsPreset ? (
            <Select
              value={
                value.videoQuality || (allowInherit ? INHERIT : "balanced")
              }
              onValueChange={(v) =>
                onChange({ videoQuality: v === INHERIT ? "" : v })
              }
            >
              <SelectTrigger className={control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={menu}>
                {allowInherit && (
                  <SelectItem value={INHERIT}>
                    {inheritLabel(
                      inherited
                        ? VIDEO_QUALITY_LABELS[inherited.videoQuality]
                        : undefined
                    )}
                  </SelectItem>
                )}
                {VIDEO_QUALITY_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {VIDEO_QUALITY_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              type="number"
              min={MIN_QUALITY}
              max={MAX_QUALITY}
              value={value.quality ?? ""}
              placeholder={
                allowInherit && inherited ? String(inherited.quality) : undefined
              }
              onChange={(e) =>
                onChange({
                  quality: e.target.value === "" ? "" : Number(e.target.value),
                })
              }
              className={control}
            />
          )}
        </div>

        {/* Scale */}
        <div className="space-y-1.5">
          <Label className={labelClass}>Scale</Label>
          <Select
            value={
              value.scale !== undefined && value.scale !== ""
                ? String(value.scale)
                : allowInherit
                  ? INHERIT
                  : String(inherited?.scale ?? 1)
            }
            onValueChange={(v) =>
              onChange({ scale: v === INHERIT ? "" : Number(v) })
            }
          >
            <SelectTrigger className={control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={menu}>
              {allowInherit && (
                <SelectItem value={INHERIT}>
                  {inheritLabel(inherited ? `${inherited.scale}x` : undefined)}
                </SelectItem>
              )}
              {SCALE_OPTIONS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}x
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {showVideo && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className={labelClass}>Frame rate (fps)</Label>
            <Input
              type="number"
              min={MIN_FPS}
              max={MAX_FPS}
              value={value.fps ?? ""}
              placeholder={
                allowInherit && inherited ? String(inherited.fps) : undefined
              }
              onChange={(e) =>
                onChange({
                  fps: e.target.value === "" ? "" : Number(e.target.value),
                })
              }
              className={control}
            />
          </div>
          {showDuration && (
          <div className="space-y-1.5">
            <Label className={labelClass}>Duration (s)</Label>
            <Input
              type="number"
              min={MIN_DURATION_SEC}
              max={MAX_DURATION_SEC}
              step={0.1}
              value={value.durationSec ?? ""}
              placeholder="Auto"
              onChange={(e) =>
                onChange({
                  durationSec:
                    e.target.value === "" ? "" : Number(e.target.value),
                })
              }
              className={control}
            />
          </div>
          )}
          {/* MP4 quality lives in the grid above when the format IS mp4; when
              the fields are shown unconditionally (Settings) the preset needs
              its own control here so image quality stays editable too. */}
          {!topQualityIsPreset && (
            <div className="space-y-1.5">
              <Label className={labelClass}>Video quality</Label>
              <Select
                value={value.videoQuality || inherited?.videoQuality || "balanced"}
                onValueChange={(v) => onChange({ videoQuality: v })}
              >
                <SelectTrigger className={control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={menu}>
                  {VIDEO_QUALITY_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {VIDEO_QUALITY_LABELS[preset]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
