"use client";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  AlignCenterHorizontal,
  AlignCenterVertical,
  Copy,
  Layers3,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { FontPicker, type CustomFont } from "@/components/editor/font-picker";
import type { VideoPreviewState } from "@/lib/editor/video-preview";
import { IconButton } from "./chrome";
export type Alignment =
  | "left"
  | "centerH"
  | "right"
  | "top"
  | "middle"
  | "bottom";
interface Props {
  object: any;
  update: (key: string, v: any) => void;
  fonts: CustomFont[];
  applyFont: (s: string) => void;
  uploadFont: (f: File) => Promise<void>;
  replace: () => void;
  remove: () => void;
  duplicate: () => void;
  align: (m: Alignment) => void;
  showLayers: () => void;
  videoCount: number;
  preview: VideoPreviewState;
  soloAll: boolean;
  setSoloAll: (b: boolean) => void;
  play: (id: string | null) => void;
  stop: () => void;
  seek: (t: number) => void;
}
function Num({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          if (e.target.value === "") return;
          const n = Number(e.target.value);
          if (Number.isFinite(n))
            onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
        }}
      />
    </label>
  );
}
function ColorField({
  label,
  value,
  set,
}: {
  label: string;
  value: string;
  set: (s: string) => void;
}) {
  return (
    <label>
      {label}
      <span className="sl-color-field">
        <input
          type="color"
          aria-label={label}
          value={/^#[a-f0-9]{6}$/i.test(value) ? value : "#000000"}
          onChange={(e) => set(e.target.value)}
        />
        <span>{typeof value === "string" ? value.toUpperCase() : "Mixed"}</span>
      </span>
    </label>
  );
}
function Toggle({
  label,
  checked,
  change,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  change: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="sl-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => change(e.target.checked)}
      />
    </label>
  );
}
export function Inspector(p: Props) {
  const o = p.object;
  const up = p.update;
  const type = o?.type || "";
  const clock = (s: number) =>
    `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  if (!o)
    return (
      <div className="sl-empty">
        <Layers3 />
        <b>No layer selected</b>
        <p>Click a layer on the canvas to edit it.</p>
        <button className="sl-secondary" onClick={p.showLayers}>
          Browse layers
        </button>
      </div>
    );
  if (type === "activeselection")
    return (
      <>
        <div className="sl-section-label">
          <span>{o.getObjects().length} layers selected</span>
        </div>
        <p className="sl-fine">
          Align the selected objects within their shared bounds.
        </p>
        <div className="sl-align-grid">
          {(
            [
              { id: "left", i: ArrowLeftToLine },
              { id: "centerH", i: AlignCenterVertical },
              { id: "right", i: ArrowRightToLine },
              { id: "top", i: ArrowUpToLine },
              { id: "middle", i: AlignCenterHorizontal },
              { id: "bottom", i: ArrowDownToLine },
            ] as const
          ).map(({ id, i: I }) => (
            <button
              key={id}
              onClick={() => p.align(id)}
              title={`Align ${id}`}
              aria-label={`Align ${id}`}
            >
              <I size={18} />
            </button>
          ))}
        </div>
        <button className="sl-secondary sl-fill" onClick={p.remove}>
          <Trash2 size={15} />
          Delete selection
        </button>
      </>
    );
  const isText = /text/.test(type),
    isImage = type === "image",
    isVideo = o.mediaType === "video";
  const id = o.id || o.name;
  const solo = p.soloAll && p.videoCount > 1 ? null : id;
  const playing = p.preview.playing && p.preview.soloLayerId === solo;
  return (
    <div className="sl-form">
      <div className="sl-inspector-key">
        <span />
        {isText ? "Text" : isVideo ? "Video" : isImage ? "Image" : "Shape"}{" "}
        layer
      </div>
      {isText && (
        <>
          <label>
            Text content
            <textarea
              aria-label="Text content"
              rows={3}
              value={o.text || ""}
              onChange={(e) => up("text", e.target.value)}
            />
          </label>
          <label>
            Typeface
            <FontPicker
              value={o.fontFamily || "Arial"}
              customFonts={p.fonts}
              onChange={p.applyFont}
              onUpload={p.uploadFont}
            />
          </label>
          <div className="sl-2cols">
            <Num
              label="Font size"
              min={1}
              max={4096}
              value={o.fontSize}
              onChange={(v) => up("fontSize", v)}
            />
            <label>
              Weight
              <select
                value={String(o.fontWeight || "normal")}
                onChange={(e) => up("fontWeight", e.target.value)}
              >
                {[
                  "normal",
                  "bold",
                  "100",
                  "200",
                  "300",
                  "400",
                  "500",
                  "600",
                  "700",
                  "800",
                  "900",
                ].map((v) => (
                  <option key={v} value={v}>
                    {v === "normal" ? "Regular" : v === "bold" ? "Bold" : v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="sl-2cols">
            <ColorField
              label="Text color"
              value={o.fill}
              set={(v) => up("fill", v)}
            />
            <label>
              Alignment
              <span className="sl-align-group">
                {(
                  [
                    { v: "left", i: AlignLeft },
                    { v: "center", i: AlignCenter },
                    { v: "right", i: AlignRight },
                  ] as const
                ).map(({ v, i: I }) => (
                  <IconButton
                    key={v}
                    label={`Align text ${v}`}
                    action={() => up("textAlign", v)}
                    pressed={o.textAlign === v}
                  >
                    <I size={14} />
                  </IconButton>
                ))}
              </span>
            </label>
          </div>
        </>
      )}
      {!isText && !isImage && (
        <>
          <ColorField
            label={type === "line" ? "Line color" : "Fill color"}
            value={type === "line" ? o.stroke : o.fill}
            set={(v) => up(type === "line" ? "stroke" : "fill", v)}
          />
          <div className="sl-2cols">
            <ColorField
              label="Stroke"
              value={o.stroke || "#000000"}
              set={(v) => up("stroke", v)}
            />
            <Num
              label="Stroke width"
              value={o.strokeWidth || 0}
              min={0}
              onChange={(v) => up("strokeWidth", v)}
            />
          </div>
          {type === "rect" && (
            <Num
              label="Corner radius"
              value={o.rx || 0}
              min={0}
              onChange={(v) => {
                up("rx", v);
                up("ry", v);
              }}
            />
          )}
        </>
      )}
      {isImage && !isVideo && (
        <button className="sl-secondary sl-fill" onClick={p.replace}>
          <Upload size={15} />
          Replace image
        </button>
      )}
      {isVideo && (
        <>
          <div className="sl-video-controls">
            <IconButton
              label={playing ? "Pause video" : "Play video"}
              action={() => p.play(solo)}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
            <IconButton label="Stop video" action={p.stop}>
              <RotateCcw size={13} />
            </IconButton>
            <input
              type="range"
              aria-label="Video playhead"
              min={0}
              max={p.preview.duration || 1}
              step={0.05}
              disabled={!p.preview.duration}
              value={p.preview.time}
              onChange={(e) => p.seek(Number(e.target.value))}
            />
            <small>{clock(p.preview.time)}</small>
          </div>
          {p.videoCount > 1 && (
            <Toggle
              label="Preview all layers"
              checked={p.soloAll}
              change={(v) => {
                p.stop();
                p.setSoloAll(v);
              }}
            />
          )}
          <div className="sl-2cols">
            <Num
              label="Trim start (s)"
              value={o.trimStart || 0}
              min={0}
              max={o.videoDuration}
              step={0.1}
              onChange={(v) => up("trimStart", v)}
            />
            <Num
              label="Trim end (s)"
              value={o.trimEnd ?? o.videoDuration}
              min={0}
              max={o.videoDuration}
              step={0.1}
              onChange={(v) => up("trimEnd", v)}
            />
          </div>
          <div className="sl-2cols">
            <Num
              label="Start at (s)"
              value={o.startAt || 0}
              min={0}
              step={0.1}
              onChange={(v) => up("startAt", v)}
            />
            <label>
              Fit
              <select
                value={o.fit || "cover"}
                onChange={(e) => up("fit", e.target.value)}
              >
                {["cover", "contain", "stretch"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          </div>
          <Toggle
            label="Loop clip"
            checked={!!o.loop}
            change={(v) => up("loop", v)}
          />
          <Toggle
            label="Mute audio"
            checked={!!o.muted}
            disabled={!o.hasAudio}
            change={(v) => up("muted", v)}
          />
          <label>
            Volume
            <input
              type="range"
              min={0}
              max={200}
              disabled={o.muted || !o.hasAudio}
              value={Math.round((o.volume ?? 1) * 100)}
              onChange={(e) => up("volume", Number(e.target.value) / 100)}
            />
          </label>
        </>
      )}
      <label>
        <span className="sl-label-end">
          Opacity <small>{Math.round((o.opacity ?? 1) * 100)}%</small>
        </span>
        <input
          aria-label="Opacity"
          type="range"
          min={0}
          max={100}
          value={Math.round((o.opacity ?? 1) * 100)}
          onChange={(e) => up("opacity", Number(e.target.value) / 100)}
        />
      </label>
      <details className="sl-details">
        <summary>Position & rotation</summary>
        <div className="sl-2cols">
          <Num
            label="X position"
            value={o.left}
            onChange={(v) => up("left", v)}
          />
          <Num
            label="Y position"
            value={o.top}
            onChange={(v) => up("top", v)}
          />
        </div>
        <Num
          label="Rotation (°)"
          value={o.angle || 0}
          onChange={(v) => up("angle", v)}
        />
      </details>
      <details className="sl-details" open={o.dynamic || undefined}>
        <summary>API field</summary>
        <label>
          Field name
          <input
            aria-label="Field name"
            maxLength={255}
            value={o.name || ""}
            placeholder="e.g. headline"
            onChange={(e) => up("name", e.target.value)}
          />
        </label>
        <Toggle
          label="Dynamic field"
          checked={o.dynamic !== false && !!o.name}
          change={(v) => {
            if (v && !o.name)
              up("name", `${type}_${o.id?.slice(-5) || "layer"}`);
            up("dynamic", v);
          }}
        />
      </details>
      <div className="sl-inline-actions">
        <button onClick={p.duplicate}>
          <Copy size={14} />
          Duplicate
        </button>
        <button className="sl-danger" onClick={p.remove}>
          <Trash2 size={14} />
          Delete
        </button>
      </div>
    </div>
  );
}
