"use client";
import { useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
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
import {
  ALIGN_OPTIONS,
  DISTRIBUTE_OPTIONS,
  type Alignment,
  type AlignTarget,
} from "./align";
interface Props {
  object: any;
  update: (key: string | Record<string, any>, v?: any) => void;
  fonts: CustomFont[];
  applyFont: (s: string) => void;
  uploadFont: (f: File) => Promise<void>;
  replace: () => void;
  remove: () => void;
  duplicate: () => void;
  align: (m: Alignment, to?: AlignTarget) => void;
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
// A whole-pixel size box that applies on Enter / blur (or straight away for the
// spinner arrows and arrow keys) instead of on every keystroke — typing "1200"
// would otherwise resize the layer to 1, 12 and 120 px on the way, with an
// undo step for each.
function SizeNum({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const shown = Number.isFinite(value) ? Math.round(value) : 0;
  const [draft, setDraft] = useState<string | null>(null);
  const apply = (raw: string) => {
    setDraft(null);
    const n = Math.round(Number(raw));
    if (raw !== "" && Number.isFinite(n) && n >= 1 && n !== shown) onCommit(n);
  };
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        min={1}
        step={1}
        value={draft ?? shown}
        onChange={(e) => {
          // Typing reports an inputType; spinner clicks and arrow keys don't.
          if ((e.nativeEvent as InputEvent).inputType) setDraft(e.target.value);
          else apply(e.target.value);
        }}
        onBlur={() => draft !== null && apply(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft !== null) apply(draft);
          else if (e.key === "Escape") setDraft(null);
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
// Width / height boxes for image and video layers. Fabric sizes images through
// scaleX / scaleY over their natural width / height, so the boxes show the
// rendered size in pixels and convert edits back to a scale.
function ImageSize({
  o,
  up,
}: {
  o: any;
  up: (key: string | Record<string, any>, v?: any) => void;
}) {
  const [locked, setLocked] = useState(true);
  const baseW = o.width || 1,
    baseH = o.height || 1;
  const sx = Math.abs(o.scaleX ?? 1),
    sy = Math.abs(o.scaleY ?? 1);
  // Keep any flip (negative scale) when changing the size.
  const sign = (s: number | undefined) => ((s ?? 1) < 0 ? -1 : 1);
  // With the aspect lock on, the other axis keeps the current ratio. A zero
  // scale has no ratio to keep (dividing by it wrote Infinity/NaN into the
  // design), so fall back to a uniform scale.
  const setWidth = (w: number) => {
    if (!Number.isFinite(w) || w <= 0) return;
    const nx = w / baseW;
    const ny = sx > 0 ? (nx * sy) / sx : nx;
    up(
      locked
        ? {
            scaleX: nx * sign(o.scaleX),
            scaleY: ny * sign(o.scaleY),
          }
        : { scaleX: nx * sign(o.scaleX) },
    );
  };
  const setHeight = (h: number) => {
    if (!Number.isFinite(h) || h <= 0) return;
    const ny = h / baseH;
    const nx = sy > 0 ? (ny * sx) / sy : ny;
    up(
      locked
        ? {
            scaleY: ny * sign(o.scaleY),
            scaleX: nx * sign(o.scaleX),
          }
        : { scaleY: ny * sign(o.scaleY) },
    );
  };
  return (
    <>
      <div className="sl-2cols">
        <SizeNum label="Width (px)" value={baseW * sx} onCommit={setWidth} />
        <SizeNum label="Height (px)" value={baseH * sy} onCommit={setHeight} />
      </div>
      <Toggle label="Lock aspect ratio" checked={locked} change={setLocked} />
    </>
  );
}
export function Inspector(p: Props) {
  const o = p.object;
  const up = p.update;
  const [alignTo, setAlignTo] = useState<AlignTarget>("selection");
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
  if (type === "activeselection") {
    const count = o.getObjects().length;
    return (
      <>
        <div className="sl-section-label">
          <span>{count} layers selected</span>
        </div>
        <label>
          Align to
          <select
            aria-label="Align to"
            value={alignTo}
            onChange={(e) => setAlignTo(e.target.value as AlignTarget)}
          >
            <option value="selection">Selection</option>
            <option value="artboard">Artboard</option>
          </select>
        </label>
        <p className="sl-fine">
          {alignTo === "artboard"
            ? "Line each object up with the artboard's edges or center."
            : "Line the objects up within their shared bounds."}
        </p>
        <div className="sl-align-grid">
          {ALIGN_OPTIONS.map(({ id, label, i: I }) => (
            <button
              key={id}
              onClick={() => p.align(id, alignTo)}
              title={label}
              aria-label={label}
            >
              <I size={18} />
            </button>
          ))}
        </div>
        <div className="sl-section-label">
          <span>Distribute</span>
        </div>
        <div className="sl-align-grid sl-align-grid-2">
          {DISTRIBUTE_OPTIONS.map(({ id, label, i: I }) => (
            <button
              key={id}
              onClick={() => p.align(id)}
              disabled={count < 3}
              title={
                count < 3 ? "Select 3 or more layers to distribute" : label
              }
              aria-label={label}
            >
              <I size={18} />
              {id === "distributeH" ? "Horizontal" : "Vertical"}
            </button>
          ))}
        </div>
        <p className="sl-fine">
          Equal spacing between objects, keeping the outermost two in place.
        </p>
        <button className="sl-secondary sl-fill" onClick={p.remove}>
          <Trash2 size={15} />
          Delete selection
        </button>
      </>
    );
  }
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
      {isImage && <ImageSize key={o.id || o.name} o={o} up={up} />}
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
