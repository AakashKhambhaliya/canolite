"use client";
/* eslint-disable @next/next/no-img-element -- These thumbnails are small bundled assets. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CloudCheck,
  Download,
  FileSliders,
  FolderOpen,
  Hand,
  Keyboard,
  Layers3,
  LayoutTemplate,
  Loader2,
  Maximize,
  Minus,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  Play,
  Plus,
  Redo2,
  Save,
  Scan,
  Settings2,
  Shapes,
  SlidersHorizontal,
  SquareDashed,
  Type,
  Undo2,
  Upload,
  Zap,
  Copy,
  Bold,
  Italic,
  Trash2,
  PanelLeftClose,
  Minimize,
  Image as ImageIcon,
  AlignCenterVertical,
} from "lucide-react";
import { ALIGN_OPTIONS, DISTRIBUTE_OPTIONS, type Alignment } from "./align";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Logo } from "@/components/logo";
import type { StudioPreset } from "@/lib/editor/studio-presets";

export type Panel =
  | "Templates"
  | "Elements"
  | "Text"
  | "Uploads"
  | "Layers"
  | "Properties";
export type StudioModal = "resize" | "settings" | "help" | null;
export function IconButton({
  label,
  children,
  action,
  disabled = false,
  pressed,
  className = "",
}: {
  label: string;
  children: ReactNode;
  action: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`sl-icon ${className}`}
      onClick={action}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}
export function StudioHeader({
  name,
  rename,
  save,
  saved,
  saving,
  undo,
  redo,
  canUndo,
  canRedo,
  preview,
  exportDesign,
  settings,
  home,
  copyId,
  automate,
  isPreview,
}: {
  name: string;
  rename: (s: string) => void;
  save: () => void;
  saved: boolean;
  saving: boolean;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  preview: () => void;
  exportDesign: () => void;
  settings: () => void;
  home: () => void;
  copyId: () => void;
  automate: () => void;
  isPreview: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const edit = () => {
    setValue(name);
    setEditing(true);
  };
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const commit = () => {
    const v = value.trim().slice(0, 200);
    if (v && name !== v) rename(v);
    setEditing(false);
  };
  return (
    <header className="sl-header">
      <div className="sl-brand">
        <Logo size={32} />
        <strong>Canolite</strong>
        <span>STUDIO</span>
      </div>
      <i className="sl-divider sl-head-divider" />
      <div className="sl-breadcrumb">
        <button
          type="button"
          className="sl-dashboard-return"
          onClick={home}
          aria-label="Back to Templates dashboard"
          title="Back to Templates dashboard"
        >
          <ArrowLeft size={14} />
          <span>Templates</span>
        </button>
        <ChevronRight size={13} className="sl-crumb" />
        {editing ? (
          <input
            ref={input}
            className="sl-rename"
            aria-label="Design name"
            maxLength={200}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="sl-document" title="Design menu">
                {name}
                <ChevronDown size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="sl-menu">
              <DropdownMenuItem onSelect={edit}>
                <Pencil />
                Rename design
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={save}>
                <Save />
                Save design
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={settings}>
                <FileSliders />
                Output settings
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={copyId}>
                <Copy />
                Copy template ID
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={automate}>
                <Zap />
                Open in Playground
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={home}>
                <FolderOpen />
                Back to templates
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!isPreview && (
        <button
          className={`sl-save ${!saved ? "is-dirty" : ""}`}
          onClick={save}
          disabled={saving}
          title="Save to your workspace (Ctrl/⌘ S)"
        >
          {saving ? (
            <Loader2 className="animate-spin" size={15} />
          ) : saved ? (
            <CloudCheck size={16} />
          ) : (
            <Save size={14} />
          )}
          <span>{saving ? "Saving…" : saved ? "Saved" : "Save changes"}</span>
        </button>
      )}
      <div className="sl-head-end">
        {!isPreview && (
          <>
            <div className="sl-history">
              <IconButton
                label="Undo (Ctrl/⌘ Z)"
                action={undo}
                disabled={!canUndo}
              >
                <Undo2 size={17} />
              </IconButton>
              <IconButton
                label="Redo (Ctrl/⌘ Shift Z)"
                action={redo}
                disabled={!canRedo}
              >
                <Redo2 size={17} />
              </IconButton>
            </div>
            <i className="sl-divider sl-head-divider" />
          </>
        )}
        <button
          className="sl-secondary sl-preview"
          onClick={preview}
          aria-label={isPreview ? "Back to editor" : "Preview design"}
        >
          {isPreview ? <ArrowLeft size={15} /> : <Play size={14} />}
          <span>{isPreview ? "Back to editor" : "Preview"}</span>
        </button>
        <button className="sl-primary sl-export" onClick={exportDesign}>
          <Download size={16} />
          Export
        </button>
      </div>
    </header>
  );
}
const railItems = [
  { id: "Templates", icon: LayoutTemplate },
  { id: "Elements", icon: Shapes },
  { id: "Text", icon: Type },
  { id: "Uploads", icon: Upload },
  { id: "Layers", icon: Layers3 },
] as const;
export function StudioRail({
  panel,
  choose,
  settings,
  help,
}: {
  panel: Panel | null;
  choose: (p: Panel) => void;
  settings: () => void;
  help: () => void;
}) {
  return (
    <nav className="sl-rail" aria-label="Editor tools">
      <div className="sl-rail-main">
        {railItems.map((item) => (
          <button
            key={item.id}
            onClick={() => choose(item.id)}
            className={`sl-rail-item ${item.id === "Layers" ? "sl-layers-rail" : ""}`}
            aria-pressed={panel === item.id}
          >
            <span>
              <item.icon size={21} strokeWidth={1.65} />
            </span>
            <small>{item.id}</small>
          </button>
        ))}
      </div>
      <div className="sl-rail-bottom">
        <button
          className="sl-rail-item"
          onClick={settings}
          title="Studio settings"
        >
          <Settings2 size={19} />
          <small>Settings</small>
        </button>
        <button
          className="sl-rail-item"
          onClick={help}
          title="Help and keyboard shortcuts"
        >
          <CircleHelp size={19} />
          <small>Help</small>
        </button>
      </div>
    </nav>
  );
}
const intro: Record<Panel, string> = {
  Templates: "A starting point for your next design.",
  Elements: "Simple shapes and original graphics.",
  Text: "Give your design a voice.",
  Uploads: "Bring your own media to the canvas.",
  Layers: "Organize the pieces of your design.",
  Properties: "Fine-tune the selected layer.",
};
export function AssetPanel({
  panel,
  close,
  children,
}: {
  panel: Panel;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="sl-panel" aria-label={`${panel} panel`}>
      <div className="sl-panel-heading">
        <div className="sl-eyebrow">
          <i />
          {panel === "Layers" || panel === "Properties"
            ? "DESIGN TOOLS"
            : "STUDIO LIBRARY"}
        </div>
        <div className="sl-panel-title">
          <h1>{panel}</h1>
          <IconButton label="Close panel" action={close}>
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
        <p>{intro[panel]}</p>
      </div>
      <div key={panel} className="sl-panel-body">
        {children}
      </div>
    </aside>
  );
}

export function ColorMenu({
  label,
  color,
  change,
  short = false,
  notice,
}: {
  label: string;
  color: string;
  change: (v: string) => void;
  short?: boolean;
  notice?: string;
}) {
  const valid = /^#[a-f\d]{6}$/i.test(color) ? color : "#ffffff";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="sl-ctrl" title={label} aria-label={label}>
          <span className="sl-swatch" style={{ background: valid }} />
          {!short && <span>{label}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="sl-pop" sideOffset={11}>
        <h3>{label}</h3>
        <div className="sl-colors">
          {[
            "#f4e7c9",
            "#ffffff",
            "#102c3c",
            "#e96847",
            "#59776a",
            "#bea8db",
            "#f5cc60",
            "#355c97",
          ].map((v) => (
            <button
              key={v}
              aria-label={`Use ${v}`}
              style={{ background: v }}
              onClick={() => change(v)}
            >
              {color.toLowerCase() === v && (
                <Check
                  size={14}
                  style={{ color: v === "#102c3c" ? "white" : "#1e211e" }}
                />
              )}
            </button>
          ))}
        </div>
        <label className="sl-custom-color">
          <input
            type="color"
            value={valid}
            onChange={(e) => change(e.target.value)}
          />
          <span>Custom color</span>
          <code>{valid.toUpperCase()}</code>
        </label>
        {notice && <p className="sl-fine">{notice}</p>}
      </PopoverContent>
    </Popover>
  );
}
export function StageToolbar({
  mode,
  setMode,
  active,
  bg,
  setBg,
  resize,
  inspect,
  layers,
  update,
  align,
  duplicate,
  remove,
  settings,
  help,
  openPanel,
  undo,
  redo,
  canUndo,
  canRedo,
}: {
  mode: "select" | "pan";
  setMode: (m: "select" | "pan") => void;
  active: any;
  bg: string;
  setBg: (v: string) => void;
  resize: () => void;
  inspect: () => void;
  layers: () => void;
  update: (k: string, v: any) => void;
  align: (m: Alignment) => void;
  duplicate: () => void;
  remove: () => void;
  settings: () => void;
  help: () => void;
  openPanel: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const t = active?.type || "";
  const isText = /text/i.test(t);
  const multi = t === "activeselection";
  const selectedCount = multi ? active.getObjects().length : 0;
  const fill = String(active?.fill || "#222222");
  return (
    <div className="sl-toolbar-wrap">
      <div className="sl-toolbar" role="toolbar" aria-label="Canvas tools">
        <IconButton
          label="Select tool (V)"
          pressed={mode === "select"}
          action={() => setMode("select")}
        >
          <MousePointer2
            size={16}
            fill={mode === "select" ? "currentColor" : "none"}
          />
        </IconButton>
        <IconButton
          label="Hand tool (H)"
          pressed={mode === "pan"}
          action={() => setMode("pan")}
        >
          <Hand size={17} />
        </IconButton>
        <i className="sl-divider" />
        {!active ? (
          <>
            <button className="sl-ctrl" onClick={resize}>
              <Scan size={16} />
              Resize
            </button>
            <i className="sl-divider" />
            <ColorMenu
              label="Background"
              color={bg}
              change={setBg}
              notice="A full-bleed image can cover the artboard color."
            />
          </>
        ) : (
          <>
            {multi ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="sl-ctrl" aria-label="Align selection">
                    <AlignCenterVertical size={15} />
                    <span>Align</span>
                    <ChevronDown size={13} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="sl-menu" align="start">
                  {ALIGN_OPTIONS.map(({ id, label, i: I }) => (
                    <DropdownMenuItem key={id} onSelect={() => align(id)}>
                      <I />
                      {label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  {DISTRIBUTE_OPTIONS.map(({ id, label, i: I }) => (
                    <DropdownMenuItem
                      key={id}
                      disabled={selectedCount < 3}
                      onSelect={() => align(id)}
                    >
                      <I />
                      {label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={inspect}>
                    <SlidersHorizontal />
                    Align to artboard…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button className="sl-ctrl" onClick={inspect}>
                {isText ? (
                  <Type size={15} />
                ) : t === "image" ? (
                  <ImageIcon size={15} />
                ) : (
                  <SlidersHorizontal size={15} />
                )}
                <span>{isText ? "Edit text" : "Edit layer"}</span>
              </button>
            )}
            {isText && (
              <>
                <IconButton
                  label="Bold"
                  action={() =>
                    update(
                      "fontWeight",
                      active.fontWeight === "bold" ||
                        Number(active.fontWeight) >= 600
                        ? "normal"
                        : "bold",
                    )
                  }
                  pressed={
                    active.fontWeight === "bold" ||
                    Number(active.fontWeight) >= 600
                  }
                >
                  <Bold size={15} />
                </IconButton>
                <IconButton
                  label="Italic"
                  action={() =>
                    update(
                      "fontStyle",
                      active.fontStyle === "italic" ? "normal" : "italic",
                    )
                  }
                  pressed={active.fontStyle === "italic"}
                >
                  <Italic size={15} />
                </IconButton>
              </>
            )}
            {!multi && t !== "image" && (
              <ColorMenu
                label="Layer color"
                short
                color={fill}
                change={(v) => update(t === "line" ? "stroke" : "fill", v)}
              />
            )}
            <i className="sl-divider" />
            <IconButton label="Duplicate selection" action={duplicate}>
              <Copy size={15} />
            </IconButton>
            <IconButton label="Delete selection" action={remove}>
              <Trash2 size={15} />
            </IconButton>
          </>
        )}
        <i className="sl-divider" />
        <button className="sl-ctrl sl-position" onClick={layers}>
          <Layers3 size={16} />
          <span>Position</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="sl-icon"
              aria-label="More editor tools"
              title="More editor tools"
            >
              <MoreHorizontal size={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="sl-menu" align="end">
            <DropdownMenuItem disabled={!canUndo} onSelect={undo}>
              <Undo2 />
              Undo
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canRedo} onSelect={redo}>
              <Redo2 />
              Redo
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openPanel}>
              <LayoutTemplate />
              Template library
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={layers}>
              <Layers3 />
              Layers and position
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={resize}>
              <Scan />
              Resize artboard
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={settings}>
              <Settings2 />
              Output settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={help}>
              <Keyboard />
              Keyboard shortcuts
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
export function StageFooter({
  zoom,
  fit,
  change,
  focus,
  toggleFocus,
  help,
  preview,
  children,
}: {
  zoom: number;
  fit: number;
  change: (v: number) => void;
  focus: boolean;
  toggleFocus: () => void;
  help: () => void;
  preview: boolean;
  children?: ReactNode;
}) {
  const actual = Math.round((zoom * fit) / 100);
  return (
    <footer className="sl-status">
      <span className="sl-artcount">
        <SquareDashed size={15} />
        {preview ? "Design preview" : "Artboard"}
        {!preview && <b>1 / 1</b>}
      </span>
      <div className="sl-foot-middle">{children}</div>
      <div className="sl-zoom">
        <IconButton
          label="Zoom out"
          action={() => change(zoom / 1.2)}
          disabled={zoom <= 10}
        >
          <Minus size={14} />
        </IconButton>
        <input
          type="range"
          aria-label="Canvas zoom"
          aria-valuetext={`${actual}% of actual size`}
          min={0}
          max={100}
          value={(Math.log(zoom / 10) / Math.log(80)) * 100}
          onChange={(e) =>
            change(10 * Math.pow(80, Number(e.target.value) / 100))
          }
        />
        <IconButton
          label="Zoom in"
          action={() => change(zoom * 1.2)}
          disabled={zoom >= 800}
        >
          <Plus size={14} />
        </IconButton>
        <button
          className="sl-zoom-value"
          onClick={() => change(100)}
          title="Fit artboard to window"
        >
          {actual}%
        </button>
        <i className="sl-divider" />
        <IconButton
          label={
            preview
              ? "Exit preview"
              : focus
                ? "Exit focus mode"
                : "Focus mode (F)"
          }
          pressed={focus}
          action={toggleFocus}
        >
          {preview ? (
            <ArrowLeft size={16} />
          ) : focus ? (
            <Minimize size={16} />
          ) : (
            <Maximize size={16} />
          )}
        </IconButton>
        <IconButton
          className="sl-shortcuts"
          label="Keyboard shortcuts"
          action={help}
        >
          <Keyboard size={17} />
        </IconButton>
      </div>
    </footer>
  );
}
export function StudioDialog({
  open,
  close,
  title,
  description,
  kicker,
  children,
  wide = false,
}: {
  open: boolean;
  close: () => void;
  title: string;
  description?: string;
  kicker?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className={`sl-dialog ${wide ? "sl-dialog-wide" : ""}`}>
        <DialogHeader>
          {kicker && (
            <span className="sl-eyebrow">
              <i />
              {kicker}
            </span>
          )}
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function PresetDialog({
  preset,
  close,
  apply,
  busy,
}: {
  preset: StudioPreset | null;
  close: () => void;
  apply: () => void;
  busy: boolean;
}) {
  return (
    <StudioDialog
      open={!!preset}
      close={close}
      title={preset?.name || "Template"}
      description={preset?.description}
      kicker="STUDIO ORIGINAL"
    >
      {preset && (
        <>
          <div className="sl-preset-preview">
            <img
              src={`/studio/thumbs/${preset.id}.webp`}
              alt={`${preset.name} artwork`}
            />
          </div>
          <div className="sl-preset-meta">
            <b>{preset.category}</b>
            <span>
              {preset.width} × {preset.height} px
            </span>
          </div>
          <p className="sl-fine">
            Replaces the artwork on this artboard. You can undo this change.
          </p>
          <button
            className="sl-primary sl-fill"
            disabled={busy}
            onClick={apply}
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <LayoutTemplate size={16} />
            )}
            Use template
          </button>
        </>
      )}
    </StudioDialog>
  );
}
export function ResizeForm({
  width,
  height,
  resize,
}: {
  width: number;
  height: number;
  resize: (w: number, h: number) => void;
}) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        resize(Number(w), Number(h));
      }}
      className="sl-form"
    >
      <div className="sl-2cols">
        <label>
          Width (px)
          <input
            type="number"
            required
            min={1}
            max={16384}
            value={w}
            onChange={(e) => setW(e.target.value)}
          />
        </label>
        <label>
          Height (px)
          <input
            type="number"
            required
            min={1}
            max={16384}
            value={h}
            onChange={(e) => setH(e.target.value)}
          />
        </label>
      </div>
      <div className="sl-inline-actions">
        <button
          type="button"
          onClick={() => {
            setW("1080");
            setH("1350");
          }}
        >
          Portrait 4:5
        </button>
        <button
          type="button"
          onClick={() => {
            setW("1080");
            setH("1080");
          }}
        >
          Square 1:1
        </button>
        <button
          type="button"
          onClick={() => {
            setW("1920");
            setH("1080");
          }}
        >
          16:9
        </button>
      </div>
      <p className="sl-fine">Layers keep their original size and position.</p>
      <button type="submit" className="sl-primary sl-fill">
        <Scan size={15} />
        Resize artboard
      </button>
    </form>
  );
}
export function HelpContent() {
  return (
    <>
      <div className="sl-keylist">
        {[
          ["Select tool", "V"],
          ["Hand tool", "H"],
          ["Focus mode", "F"],
          ["Find a template", "/"],
          ["Save design", "Ctrl / ⌘ S"],
          ["Undo", "Ctrl / ⌘ Z"],
          ["Redo", "Ctrl / ⌘ ⇧ Z"],
          ["Duplicate layer", "Ctrl / ⌘ D"],
          ["Nudge 1 px / 10 px", "↑ / ⇧ ↑"],
          ["Zoom around pointer", "Alt + wheel"],
        ].map(([s, k]) => (
          <div key={s}>
            <span>{s}</span>
            <kbd>{k}</kbd>
          </div>
        ))}
      </div>
      <p className="sl-fine">
        Your design is stored in your Canolite workspace when you save.
      </p>
    </>
  );
}
