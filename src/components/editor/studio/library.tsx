"use client";
/* eslint-disable @next/next/no-img-element -- Pre-sized local thumbnails, SVG assets and uploaded data URLs are displayed directly. */

import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  Diamond,
  Eye,
  EyeOff,
  GripVertical,
  Image as ImageIcon,
  Layers3,
  LayoutTemplate,
  LockKeyhole,
  Minus,
  Search,
  Shapes,
  Sparkles,
  Square,
  Triangle,
  Type,
  UnlockKeyhole,
  Upload,
  Video,
  X,
} from "lucide-react";
import {
  STUDIO_PRESETS,
  STUDIO_GRAPHICS,
  type StudioPreset,
} from "@/lib/editor/studio-presets";

export function TemplateLibrary({
  current,
  choose,
}: {
  current?: string;
  choose: (p: StudioPreset) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const filtered = STUDIO_PRESETS.filter(
    (p) =>
      (category === "All" ||
        `${p.category}${p.category === "Social" ? "" : "s"}` === category) &&
      `${p.name} ${p.category} ${p.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="sl-search">
        <Search size={16} />
        <input
          aria-label="Search templates"
          placeholder="Search templates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button onClick={() => setQuery("")} aria-label="Clear search">
            <X size={14} />
          </button>
        ) : (
          <kbd>/</kbd>
        )}
      </div>
      <div className="sl-filters" aria-label="Template categories">
        {["All", "Posters", "Social", "Prints"].map((v) => (
          <button
            key={v}
            aria-pressed={category === v}
            onClick={() => setCategory(v)}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="sl-section-label">
        <span>
          <Sparkles size={14} />{" "}
          {query.trim()
            ? "Search results"
            : category === "All"
              ? "Studio picks"
              : `${category} collection`}
        </span>
        <small>{String(filtered.length).padStart(2, "0")}</small>
      </div>
      <div className="sl-template-grid">
        {filtered.map((p) => (
          <button
            key={p.id}
            className="sl-template"
            aria-label={`Use ${p.name} template`}
            onClick={() => choose(p)}
          >
            <div
              className={`sl-thumb ${current === p.id ? "is-current" : ""}`}
              style={{ background: p.background }}
            >
              <img
                src={`/studio/thumbs/${p.id}.webp`}
                alt=""
                draggable={false}
                style={
                  p.width === p.height ? { objectFit: "contain" } : undefined
                }
              />
              {current === p.id && (
                <span className="sl-tick">
                  <Check size={11} strokeWidth={3} />
                </span>
              )}
              <span className="sl-card-arrow">
                <ArrowUpRight size={14} />
              </span>
            </div>
            <strong>{p.name}</strong>
            <small>{p.category}</small>
          </button>
        ))}
      </div>
      {!filtered.length && (
        <div className="sl-empty">
          <Search />
          <b>No matching templates</b>
          <p>Try another name or category.</p>
          <button
            className="sl-link"
            onClick={() => {
              setQuery("");
              setCategory("All");
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      {filtered.length > 0 && (
        <div className="sl-endnote">
          <span /> CANOLITE ORIGINALS <span />
        </div>
      )}
    </>
  );
}

export type ShapeKind =
  | "rectangle"
  | "circle"
  | "triangle"
  | "line"
  | "diamond";
export function ElementLibrary({
  addShape,
  addGraphic,
}: {
  addShape: (kind: ShapeKind) => void;
  addGraphic: (src: string, name: string) => void;
}) {
  const shapes = [
    { id: "rectangle", label: "Rectangle", icon: Square },
    { id: "circle", label: "Circle", icon: Circle },
    { id: "triangle", label: "Triangle", icon: Triangle },
    { id: "line", label: "Line", icon: Minus },
    { id: "diamond", label: "Diamond", icon: Diamond },
  ] as const;
  return (
    <>
      <div className="sl-section-label">
        <span>Basic shapes</span>
        <small>05</small>
      </div>
      <div className="sl-asset-grid">
        {shapes.map((s) => (
          <button key={s.id} onClick={() => addShape(s.id)}>
            <s.icon
              size={31}
              fill={s.id === "line" ? "none" : "currentColor"}
              strokeWidth={2}
            />
            <small>{s.label}</small>
          </button>
        ))}
      </div>
      <div className="sl-section-label">
        <span>Studio graphics</span>
        <small>06</small>
      </div>
      <div className="sl-asset-grid">
        {STUDIO_GRAPHICS.map((g) => (
          <button key={g.name} onClick={() => addGraphic(g.src, g.name)}>
            <img src={g.src} alt="" />
            <small>{g.name}</small>
          </button>
        ))}
      </div>
    </>
  );
}
export type TextKind =
  | "heading"
  | "subheading"
  | "body"
  | "editorial"
  | "caption";
export function TextLibrary({ add }: { add: (kind: TextKind) => void }) {
  return (
    <>
      <button className="sl-primary sl-fill" onClick={() => add("body")}>
        <Type size={16} /> Add a text box
      </button>
      <div className="sl-section-label">
        <span>Text styles</span>
      </div>
      <div className="sl-type-presets">
        {(
          [
            ["heading", "Add a heading"],
            ["subheading", "Add a subheading"],
            ["body", "Add body text"],
            ["editorial", "Editorial italic"],
            ["caption", "MONO CAPTION"],
          ] as const
        ).map(([id, name]) => (
          <button className={`sl-type-${id}`} key={id} onClick={() => add(id)}>
            {name}
            <span>+</span>
          </button>
        ))}
      </div>
      <div className="sl-notice">
        <Type size={17} />
        <p>Double-click any text on the canvas to edit it in place.</p>
      </div>
    </>
  );
}
export function UploadLibrary({
  addImage,
  addVideo,
  used,
  insert,
  drop,
}: {
  addImage: () => void;
  addVideo: () => void;
  used: Array<{ src: string; name: string }>;
  insert: (src: string, name: string) => void;
  drop: (file: File) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <>
      <button
        className={`sl-drop ${hover ? "is-over" : ""}`}
        onClick={addImage}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          const f = e.dataTransfer.files[0];
          if (f) drop(f);
        }}
      >
        <span>
          <Upload size={24} />
        </span>
        <b>Upload an image</b>
        <p>Choose a file or drop it here</p>
        <small>PNG, JPG, WebP or SVG</small>
      </button>
      <button className="sl-secondary sl-fill" onClick={addVideo}>
        <Video size={16} /> Upload a video
      </button>
      <div className="sl-section-label">
        <span>Images in this design</span>
        <small>{String(used.length).padStart(2, "0")}</small>
      </div>
      <div className="sl-used-grid">
        {used.map((u, i) => (
          <button
            key={i}
            onClick={() => insert(u.src, u.name)}
            title={`Add another ${u.name}`}
          >
            <img src={u.src} alt={u.name.replaceAll("_", " ")} />
          </button>
        ))}
      </div>
      {!used.length && (
        <p className="sl-fine">Your images will appear here as you add them.</p>
      )}
    </>
  );
}

export interface StudioLayer {
  id: string;
  name: string;
  type: string;
  locked: boolean;
  visible: boolean;
  dynamic: boolean;
  mediaType?: string;
  object: any;
}
export function LayerLibrary({
  layers,
  active,
  select,
  toggle,
  reorder,
  inspect,
}: {
  layers: StudioLayer[];
  active: any;
  select: (layer: StudioLayer) => void;
  toggle: (layer: StudioLayer, prop: "lock" | "visible") => void;
  reorder: (from: number, to: number) => void;
  inspect: () => void;
}) {
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const index = layers.findIndex((l) => l.object === active);
  return (
    <>
      <div className="sl-section-label sl-first">
        <span>Stacking order</span>
        <small>{layers.length} layers</small>
      </div>
      <div className="sl-layer-list">
        {layers.map((l, i) => {
          const Icon =
            l.mediaType === "video"
              ? Video
              : l.type === "image"
                ? ImageIcon
                : /text/.test(l.type)
                  ? Type
                  : Shapes;
          return (
            <div
              key={l.id}
              draggable
              onDragStart={(e) => {
                drag.current = i;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragOver={(e) => {
                if (drag.current !== null) {
                  e.preventDefault();
                  setOver(i);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag.current !== null) reorder(drag.current, i);
                drag.current = null;
                setOver(null);
              }}
              onDragEnd={() => {
                drag.current = null;
                setOver(null);
              }}
              className={`sl-layer ${active === l.object ? "is-active" : ""} ${over === i ? "is-over" : ""} ${!l.visible ? "is-hidden" : ""}`}
            >
              <GripVertical size={12} className="sl-grip" />
              <button
                className="sl-layer-title"
                onClick={() => select(l)}
                disabled={l.locked || !l.visible}
              >
                <Icon size={15} />
                <span>{l.name.replaceAll("_", " ")}</span>
                {l.dynamic && <i title="Dynamic field" />}
              </button>
              <button
                title={`${l.locked ? "Unlock" : "Lock"} ${l.name}`}
                onClick={() => toggle(l, "lock")}
              >
                {l.locked ? (
                  <LockKeyhole size={13} />
                ) : (
                  <UnlockKeyhole size={13} />
                )}
              </button>
              <button
                title={`${l.visible ? "Hide" : "Show"} ${l.name}`}
                onClick={() => toggle(l, "visible")}
              >
                {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </div>
          );
        })}
      </div>
      {!layers.length && (
        <div className="sl-empty">
          <Layers3 />
          <b>No layers yet</b>
          <p>Add text, an image or a shape to get started.</p>
        </div>
      )}
      {index >= 0 && (
        <>
          <div className="sl-inline-actions">
            <button
              disabled={index === 0}
              onClick={() => reorder(index, index - 1)}
            >
              <ArrowUp size={14} />
              Forward
            </button>
            <button
              disabled={index === layers.length - 1}
              onClick={() => reorder(index, index + 1)}
            >
              <ArrowDown size={14} />
              Backward
            </button>
          </div>
          <button className="sl-secondary sl-fill" onClick={inspect}>
            Edit layer properties <ChevronRight size={15} />
          </button>
        </>
      )}
      <div className="sl-notice">
        <LayoutTemplate size={16} />
        <p>Drag layers to reorder. The top layer sits in front.</p>
      </div>
    </>
  );
}
