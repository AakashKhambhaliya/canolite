"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { portableStorageImages } from "@/lib/editor/svg-assets";
import { CANOLITE_ORIGIN } from "@/lib/editor/fabric-defaults";
import {
  loadArtwork,
  maxDisplayZoom,
  pushSnapshot,
  rasterExportIssue,
} from "@/lib/editor/artwork";

import { installSnapping } from "@/lib/editor/snapping";
import { ensureFont, registerCustomFont } from "@/lib/editor/font-loader";
import { EXTRA_PROPS } from "@/lib/editor/serialized-props";
import {
  collectVideoObjects,
  VideoPreview,
  type VideoPreviewState,
} from "@/lib/editor/video-preview";
import { type CustomFont } from "@/components/editor/font-picker";
import { ExportDialog } from "@/components/editor/export-dialog";
import {
  OutputSettingsFields,
  type OutputSettingsValue,
} from "@/components/output-settings-fields";
import {
  crfToVideoQuality,
  estimateOutputSizeLabel,
  resolveOutputSettings,
  videoQualityToCrf,
  type PartialOutputSettings,
} from "@/lib/output-settings";
import { useOutputDefaults } from "@/hooks/use-output-settings";
import { useRenderStats } from "@/hooks/use-render-stats";
import {
  describeEstimate,
  estimateRenderMs,
  formatEta,
} from "@/lib/render-time";
import {
  ArrowLeft,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import {
  AssetPanel,
  HelpContent,
  IconButton,
  PresetDialog,
  ResizeForm,
  StageFooter,
  StageToolbar,
  StudioDialog,
  StudioHeader,
  StudioRail,
  type Panel,
  type StudioModal,
} from "./studio/chrome";
import {
  ElementLibrary,
  LayerLibrary,
  TemplateLibrary,
  TextLibrary,
  UploadLibrary,
  type ShapeKind,
  type StudioLayer,
  type TextKind,
} from "./studio/library";
import { Inspector } from "./studio/inspector";
import type { Alignment, AlignTarget } from "./studio/align";
import {
  STUDIO_PRESETS,
  presetDesign,
  type StudioPreset,
} from "@/lib/editor/studio-presets";
import "./studio/studio.css";

// We'll store the fabric module reference once loaded
let fabricModule: typeof import("fabric") | null = null;

const HISTORY_PROPS = [...EXTRA_PROPS];

async function loadFabric() {
  if (fabricModule) return fabricModule;
  fabricModule = await import("fabric");
  Object.assign(fabricModule.BaseFabricObject.ownDefaults, CANOLITE_ORIGIN);
  // A self-hosted document can move to a new domain. Retain root-relative
  // /storage image URLs instead of serializing the current browser host.
  fabricModule.FabricImage.ownDefaults.srcFromAttribute = true;
  return fabricModule;
}

// After a web font loads or a font changes, Fabric keeps a stale per-family
// glyph-metric cache and stale object caches, so text keeps rendering in the
// fallback font. Clear the font cache, re-measure every text object, and
// repaint (twice, to cover the next frame once glyphs are ready).
function refreshTextFonts(canvas: any) {
  if (!canvas || canvas.disposed || canvas.destroyed) return;
  try {
    const { cache } = fabricModule || {};
    cache?.clearFontCache?.();
  } catch {}
  for (const o of canvas.getObjects()) {
    if (/text|textbox|i-text/i.test(o.type || "")) {
      if (typeof o.initDimensions === "function") o.initDimensions();
      o.dirty = true;
      o.setCoords?.();
    }
  }
  canvas.renderAll();
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => {
      if (!canvas.disposed && !canvas.destroyed) canvas.renderAll();
    });
  }
}

/** Seconds as m:ss.d, for the video playback readout. */
function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs.toFixed(1)}`;
}

export function EditorWorkspace({
  templateId,
  navigate,
}: {
  templateId: string;
  navigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel | null>("Templates");
  const [modal, setModal] = useState<StudioModal>(null);
  const [pendingPreset, setPendingPreset] = useState<StudioPreset | null>(null);
  const [applying, setApplying] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [canvasError, setCanvasError] = useState(false);
  const [docSize, setDocSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const docInfo = useRef({ width: 1080, height: 1350, name: "Untitled" });
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 740px)");
    const change = () => setPanel(mq.matches ? null : "Templates");
    change();
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  const choosePanel = (p: Panel) => {
    setFocusMode(false);
    setPanel((old) => (old === p ? null : p));
  };
  const showPanel = (p: Panel) => {
    setFocusMode(false);
    setPanel(p);
  };
  const mobileClose = () => {
    if (window.matchMedia("(max-width: 740px)").matches) setPanel(null);
  };
  const panOrigin = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<any>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // Set by the Alt+wheel handler right before it changes `zoom`, so the zoom
  // effect (which actually resizes the canvas) knows which on-canvas point was
  // under the cursor and can correct scroll to keep it there. Null means the
  // pending zoom change (if any) didn't come from the wheel — e.g. slider/
  // buttons — so scroll should be left alone.
  const wheelZoomAnchorRef = useRef<{
    clientX: number;
    clientY: number;
    fracX: number;
    fracY: number;
  } | null>(null);
  // True once the canvas has been initialized for the current mount. Prevents
  // background refetches / cache updates from re-initializing (and wiping) the
  // live canvas. Reset on unmount so each (re)open initializes cleanly.
  const initializedRef = useRef(false);
  // Suppress "unsaved" marking while loadFromJSON fires object:added events.
  const loadingRef = useRef(false);

  const [, setSelectedObject] = useState<any>(null);
  // `zoom` is a percentage of "fit" (100 = whole canvas visible), not of the
  // template's native pixel size — see the zoom-apply effect below. That way
  // the same displayed number, range, and per-click step mean the same thing
  // regardless of the template's actual pixel dimensions.
  const [zoom, setZoom] = useState(100);
  // The native "% of actual pixel size" zoom that makes the whole template
  // fit inside the workspace viewport. Recomputed on resize; this is the
  // conversion factor between the displayed fit-relative `zoom` and the
  // native fraction Fabric's canvas actually renders at.
  const [fitPct, setFitPct] = useState(20);
  const [saving, setSaving] = useState(false);
  const [saved, setSavedState] = useState(true);
  const revision = useRef(0);
  const writeLock = useRef(false);
  const serverVersion = useRef(1);
  const lifetime = useRef<AbortController | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [saveIssue, setSaveIssue] = useState<{
    message: string;
    conflict: boolean;
  } | null>(null);
  const setSaved = useCallback((value: boolean) => {
    if (!value) revision.current++;
    setSavedState(value);
  }, []);
  const [templateName, setTemplateName] = useState("Untitled");
  const [layers, setLayers] = useState<any[]>([]);
  const [activeTool, setActiveTool] = useState<"select" | "pan">("select");
  const [canvasReady, setCanvasReady] = useState(false);
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  /**
   * Per-template output defaults. A blank field means "inherit the global
   * default from Settings" — the same universal chain the Playground and the
   * render API use (lib/output-settings.ts), so what is set here is what the
   * template actually renders with everywhere.
   */
  const [templateOutput, setTemplateOutput] = useState<OutputSettingsValue>({});
  const { defaults: globalOutputDefaults } = useOutputDefaults();
  // Force re-render helper
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  // ---- Video preview -------------------------------------------------------
  // Plays the real clips on the canvas instead of their static poster frames.
  // The controller owns the <video> elements and the animation loop; see
  // lib/editor/video-preview.ts for why it never mutates the Fabric objects'
  // serialized state.
  const videoPreviewRef = useRef<VideoPreview | null>(null);
  const [previewState, setPreviewState] = useState<VideoPreviewState>({
    playing: false,
    time: 0,
    duration: 0,
    soloLayerId: null,
    ready: false,
  });
  // Preview the composed timeline (every clip, from t=0) rather than just the
  // selected one. Only surfaced when the design has more than one video layer,
  // since with a single clip the two modes differ only in whether its
  // `Start at` delay is played out as dead time first.
  const [previewAllLayers, setPreviewAllLayers] = useState(false);

  // Halt any preview before an operation that reads or replaces the canvas.
  // Saving and exporting are safe either way (the preview leaves no trace in
  // toObject()), but a running preview holds references to live Fabric objects
  // that undo/redo is about to throw away, and leaving a clip playing over a
  // canvas the user just navigated off is disorienting.
  const stopVideoPreview = useCallback(() => {
    videoPreviewRef.current?.stop();
  }, []);

  // ---- Undo / redo history -------------------------------------------------
  // Fabric v6 has no built-in history, so we keep a bounded stack of canvas
  // JSON snapshots. Pushed on every add/modify/remove; restored on undo/redo.
  const MIN_ZOOM_PCT = 10; // 10% of fit
  const MAX_ZOOM_PCT = 800; // 8x fit
  const historyRef = useRef<{
    stack: string[];
    index: number;
    restoring: boolean;
  }>({ stack: [], index: -1, restoring: false });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // The event handlers registered inside the init effect close over an early
  // render, so we reach the latest snapshot fn through a ref.
  const snapshotRef = useRef<() => void>(() => {});

  // A canvas is an editable working copy, not a live query result. Wait for a
  // fresh read on *each open*. Never seed from stale cached data, then ignore
  // the authoritative response because the canvas was already initialized.
  const [fetchedTemplate, setFetchedTemplate] = useState<any>(null);
  const [readError, setReadError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReadError("");
    (async () => {
      const r = await fetch(
        `/api/templates/${encodeURIComponent(templateId)}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!r.ok)
        throw new Error(
          r.status === 401
            ? "Your session expired. Sign in to reopen this design."
            : r.status === 404
              ? "This template no longer exists."
              : "Could not reach your workspace. Try again.",
        );
      const row = await r.json();
      if (row?.id !== templateId)
        throw new Error("The workspace returned a different template.");
      if (!controller.signal.aborted) {
        serverVersion.current = row.version ?? 1;
        setFetchedTemplate(row);
      }
    })().catch((error) => {
      if (!controller.signal.aborted)
        setReadError(
          error instanceof Error
            ? error.message
            : "Could not load this template.",
        );
    });
    return () => controller.abort();
  }, [templateId, readAttempt]);

  const template = useMemo(
    () =>
      fetchedTemplate && docSize
        ? { ...fetchedTemplate, ...docSize }
        : fetchedTemplate,
    [fetchedTemplate, docSize],
  );

  // Update layers list from canvas
  const updateLayers = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const objects = canvas.getObjects();
    setLayers(
      [...objects].reverse().map((obj: any, idx: number) => {
        // Ensure a stable id so React keys survive reordering (persisted on save).
        if (!obj.id) {
          obj.id = `obj_${Date.now().toString(36)}_${Math.random()
            .toString(36)
            .slice(2, 7)}`;
        }
        return {
          id: obj.id,
          name: obj.name || `Layer ${objects.length - idx}`,
          type: obj.type,
          visible: obj.visible !== false,
          locked: obj.selectable === false,
          dynamic: obj.dynamic !== false && !!obj.name,
          mediaType: obj.mediaType,
          videoDuration: obj.videoDuration,
          object: obj,
        };
      }),
    );
  }, []);

  // Reorder layers (panel order is top→bottom; Fabric stacking is bottom→top).
  const reorderLayers = useCallback(
    (from: number, to: number) => {
      const canvas = fabricCanvasRef.current;
      if (!canvas || from == null || to == null || from === to) return;
      const panel = [...layers];
      if (from < 0 || from >= panel.length || to < 0 || to >= panel.length)
        return;
      const [moved] = panel.splice(from, 1);
      panel.splice(to, 0, moved);
      // Apply the new stacking: bottom→top is the panel reversed. Fabric v6
      // renamed the per-object stacking helper to `moveObjectTo` (the old
      // `canvas.moveTo` no longer exists and threw at runtime).
      [...panel].reverse().forEach((l, i) => canvas.moveObjectTo(l.object, i));
      canvas.renderAll();
      setSaved(false);
      updateLayers();
      snapshotRef.current();
      rerender();
    },
    [layers, updateLayers, rerender, setSaved],
  );

  // Serialize the current canvas and push it onto the history stack. No-ops
  // while loading a template or restoring a snapshot (so those don't pollute
  // history), and de-dupes identical consecutive states.
  const pushHistory = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const h = historyRef.current;
    if (h.restoring || loadingRef.current) return;
    // Guard the same Fabric toObject crash handleSave does (text with an
    // undefined `styles`).
    for (const o of canvas.getObjects() as any[]) {
      if (
        /text|textbox|i-text/i.test(o.type || "") &&
        (!o.styles || typeof o.styles !== "object")
      ) {
        o.styles = {};
      }
    }
    const json = JSON.stringify({
      ...docInfo.current,
      designJson: canvas.toObject(HISTORY_PROPS),
    });
    if (h.stack[h.index] === json) return;
    // Drop any redo tail, append, and cap the stack length.
    h.stack = pushSnapshot(h.stack, h.index, json);
    h.index = h.stack.length - 1;
    setCanUndo(h.index > 0);
    setCanRedo(false);
  }, []);
  // Keep the ref current so canvas event handlers call the latest version.
  snapshotRef.current = pushHistory;

  const stepHistory = useCallback(
    async (step: -1 | 1) => {
      const canvas = fabricCanvasRef.current,
        signal = lifetime.current?.signal;
      const h = historyRef.current,
        index = h.index + step;
      if (
        !canvas ||
        !signal ||
        loadingRef.current ||
        h.restoring ||
        index < 0 ||
        index >= h.stack.length
      )
        return;
      h.restoring = loadingRef.current = true;
      setRestoring(true);
      stopVideoPreview();
      try {
        const snap = JSON.parse(h.stack[index]);
        await loadArtwork(canvas, snap.designJson, signal);
        if (signal.aborted) return;
        h.index = index;
        setCanUndo(index > 0);
        setCanRedo(index < h.stack.length - 1);
        docInfo.current = {
          name: snap.name,
          width: snap.width,
          height: snap.height,
        };
        setTemplateName(snap.name);
        setDocSize({ width: snap.width, height: snap.height });
        setSelectedObject(null);
        setSaved(false);
        updateLayers();
        rerender();
      } catch {
        if (!signal.aborted)
          toast.error(
            "Could not restore that edit. Your current artwork was kept.",
          );
      } finally {
        if (!signal.aborted) {
          h.restoring = loadingRef.current = false;
          setRestoring(false);
        }
      }
    },
    [stopVideoPreview, setSaved, updateLayers, rerender],
  );
  const undo = useCallback(() => {
    void stepHistory(-1);
  }, [stepHistory]);
  const redo = useCallback(() => {
    void stepHistory(1);
  }, [stepHistory]);

  // Batch multi-selection edits into a single undo step. Discard the temporary
  // ActiveSelection first so cloned children have artboard-space coordinates.
  const duplicateSelected = useCallback(async () => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || loadingRef.current) return;
    const items = canvas.getActiveObjects();
    if (!items.length) return;
    canvas.discardActiveObject();
    loadingRef.current = true;
    try {
      const copies = await Promise.all(
        items.map(async (o: any) => {
          const c = await o.clone(HISTORY_PROPS);
          c.set({
            left: o.left + 16,
            top: o.top + 16,
            id: undefined,
            name: o.name ? `${o.name}_copy` : "",
          });
          return c;
        }),
      );
      if (canvas !== fabricCanvasRef.current) {
        copies.forEach((o) => o.dispose());
        return;
      }
      canvas.add(...copies);
      canvas.setActiveObject(
        copies.length === 1
          ? copies[0]
          : new fabricModule!.ActiveSelection(copies, { canvas }),
      );
    } catch {
      if (canvas === fabricCanvasRef.current)
        toast.error("Could not duplicate the selected layers.");
      return;
    } finally {
      loadingRef.current = false;
    }
    if (canvas === fabricCanvasRef.current) {
      canvas.requestRenderAll();
      canvas.fire("object:modified");
    }
  }, []);
  const removeSelected = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    const items = canvas?.getActiveObjects() || [];
    if (!items.length || loadingRef.current) return;
    canvas.discardActiveObject();
    loadingRef.current = true;
    try {
      canvas.remove(...items);
    } finally {
      loadingRef.current = false;
      canvas.requestRenderAll();
      canvas.fire("object:modified");
    }
  }, []);

  // Move the selected object by a keyboard nudge (1px, or 10px with Shift).
  const nudgeSelected = useCallback((dx: number, dy: number) => {
    const canvas = fabricCanvasRef.current;
    const active = canvas?.getActiveObject();
    if (!canvas || !active) return;
    active.set({ left: (active.left || 0) + dx, top: (active.top || 0) + dy });
    active.setCoords();
    canvas.renderAll();
    // Reuse the modified path so it marks unsaved + records history.
    canvas.fire("object:modified", { target: active });
  }, []);

  // Align every object in the current multi-selection to an edge/center of
  // their shared bounding box (the standard design-tool meaning of "align").
  // `getBoundingRect()` returns absolute canvas coordinates even for objects
  // nested in the active selection, and `setXY` takes an absolute point and
  // converts it back to the selection-relative coordinates Fabric stores
  // internally — so this works without hand-rolling that conversion.
  //
  // `to: "artboard"` lines each object up with the artboard instead of the
  // selection. "distributeH" / "distributeV" space 3+ objects evenly between
  // the outermost two (equal gaps between their edges).
  const alignSelected = useCallback(
    (mode: Alignment, to: AlignTarget = "selection") => {
      const canvas = fabricCanvasRef.current;
      const active = canvas?.getActiveObject();
      // Fabric's runtime type string for a multi-selection is the all-lowercase
      // "activeselection" (only the classRegistry key is camelCased), so match
      // case-insensitively rather than assuming "activeSelection".
      if (
        !canvas ||
        !fabricModule ||
        !active ||
        (active.type || "").toLowerCase() !== "activeselection"
      )
        return;
      const objects: any[] = active.getObjects();
      if (objects.length < 2) return;

      const fabric = fabricModule;
      const move = (obj: any, dx: number, dy: number) => {
        if (!dx && !dy) return;
        const p = obj.getXY();
        obj.setXY(new fabric.Point(p.x + dx, p.y + dy));
        obj.setCoords();
      };

      if (mode === "distributeH" || mode === "distributeV") {
        if (objects.length < 3) return;
        const horiz = mode === "distributeH";
        const start = (b: any) => (horiz ? b.left : b.top);
        const size = (b: any) => (horiz ? b.width : b.height);
        const items = objects
          .map((obj) => ({ obj, b: obj.getBoundingRect() }))
          .sort(
            (a, b) => start(a.b) + size(a.b) / 2 - (start(b.b) + size(b.b) / 2),
          );
        const first = items[0].b,
          last = items[items.length - 1].b;
        const span = start(last) + size(last) - start(first);
        const total = items.reduce((n, i) => n + size(i.b), 0);
        const gap = (span - total) / (items.length - 1);
        let cursor = start(first) + size(first) + gap;
        for (const { obj, b } of items.slice(1, -1)) {
          const d = cursor - start(b);
          move(obj, horiz ? d : 0, horiz ? 0 : d);
          cursor += size(b) + gap;
        }
      } else {
        // Bounding rects are in artboard (scene) coordinates, so the artboard
        // spans 0..canvas size divided by the current zoom.
        const sel =
          to === "artboard"
            ? {
                left: 0,
                top: 0,
                width: canvas.getWidth() / canvas.getZoom(),
                height: canvas.getHeight() / canvas.getZoom(),
              }
            : active.getBoundingRect();

        for (const obj of objects) {
          const bounds = obj.getBoundingRect();
          let dx = 0;
          let dy = 0;
          if (mode === "left") dx = sel.left - bounds.left;
          else if (mode === "centerH")
            dx = sel.left + sel.width / 2 - (bounds.left + bounds.width / 2);
          else if (mode === "right")
            dx = sel.left + sel.width - (bounds.left + bounds.width);
          else if (mode === "top") dy = sel.top - bounds.top;
          else if (mode === "middle")
            dy = sel.top + sel.height / 2 - (bounds.top + bounds.height / 2);
          else if (mode === "bottom")
            dy = sel.top + sel.height - (bounds.top + bounds.height);
          move(obj, dx, dy);
        }
      }

      // An ActiveSelection never re-derives its own bounding box when its
      // children move (by design, so dragging one member out of a selection
      // that came from an interactive group doesn't relayout that group) —
      // so its outline/handles would keep showing the pre-alignment box.
      // Discard and reselect the same objects to force a fresh one.
      canvas.discardActiveObject();
      const fresh = new fabricModule.ActiveSelection(objects, { canvas });
      canvas.setActiveObject(fresh);
      canvas.requestRenderAll();
      canvas.fire("object:modified", { target: fresh });
    },
    [],
  );

  // The latest fetched template, for the init effect below to read WITHOUT
  // taking a dependency on the query object's identity. See the effect's deps.
  const templateRef = useRef<any>(null);
  templateRef.current = template;

  // Initialize Fabric canvas — once per mount, from the loaded template.
  useEffect(() => {
    const template = templateRef.current;
    if (!canvasRef.current || !template || initializedRef.current) return;
    initializedRef.current = true;

    // `disposed` is scoped to this effect invocation. Under React 18 Strict
    // Mode the effect runs → cleanup → effect again; the cleanup of the first
    // run sets disposed=true so its in-flight async init bails out instead of
    // creating an orphan canvas, while the second run creates the live one.
    let disposed = false;
    const controller = new AbortController();
    lifetime.current = controller;
    let localCanvas: any = null;
    let cleanupSnap: (() => void) | null = null;
    loadingRef.current = true;

    (async () => {
      const fabric = await loadFabric();
      if (disposed || !canvasRef.current) return;

      const { Canvas } = fabric;
      // Canvas2D needs resolved colors, not CSS var() expressions. Only the
      // interactive controls use these tokens; the design keeps its own paint.
      const style = getComputedStyle(canvasRef.current);
      const accent = style.getPropertyValue("--sl-accent").trim();
      Object.assign(fabric.InteractiveFabricObject.ownDefaults, {
        cornerStyle: "circle",
        cornerColor: "#fff",
        cornerStrokeColor: accent,
        transparentCorners: false,
        borderColor: accent,
        cornerSize: 9,
        borderScaleFactor: 1.4,
        padding: 1,
      });
      const canvas = new Canvas(canvasRef.current, {
        // Start at one pixel; fit the viewport before allocating a backing store.
        width: 1,
        height: 1,
        backgroundColor: template.designJson?.background || "#ffffff",
        preserveObjectStacking: true,
        selection: true,
        selectionColor: style.getPropertyValue("--sl-marquee").trim(),
        selectionBorderColor: accent,
      });

      localCanvas = canvas;
      fabricCanvasRef.current = canvas;
      setTemplateName(template.name || "Untitled");
      docInfo.current = {
        width: template.width,
        height: template.height,
        name: template.name || "Untitled",
      };
      // Load per-template output defaults (image + video in one object).
      const od = (template.outputDefaults as any) || {};
      const vd = (template.videoDefaults as any) || {};
      setTemplateOutput({
        format: od.format || "",
        quality: od.quality ?? "",
        scale: od.scale ?? "",
        fps: vd.fps ?? "",
        durationSec: vd.durationSec ?? "",
        videoQuality: vd.crf !== undefined ? crfToVideoQuality(vd.crf) : "",
      });

      // Include background-only documents (even when there are no objects).
      if (template.designJson != null)
        await loadArtwork(canvas, template.designJson, controller.signal);
      if (disposed) return;
      updateLayers();
      loadingRef.current = false;
      setSaved(true);
      setCanvasReady(true);
      historyRef.current = { stack: [], index: -1, restoring: false };
      snapshotRef.current();
      setCanUndo(false);
      setCanRedo(false);
      const families = new Set<string>();
      for (const obj of canvas.getObjects())
        if ((obj as any).fontFamily) families.add((obj as any).fontFamily);
      families.forEach((f) => {
        void ensureFont(f)
          .then(() => {
            if (!disposed) refreshTextFonts(canvas);
          })
          .catch(() => {});
      });
      // Mark live Fabric text dirty while typing, not only after focus leaves it.
      canvas.on("text:changed", () => {
        if (!loadingRef.current) setSaved(false);
      });
      // Selection events
      canvas.on("selection:created", (e: any) => {
        const target = e.selected?.[0] || canvas.getActiveObject();
        setSelectedObject(target || null);
        rerender();
      });
      canvas.on("selection:updated", (e: any) => {
        const target = e.selected?.[0] || canvas.getActiveObject();
        setSelectedObject(target || null);
        rerender();
      });
      canvas.on("selection:cleared", () => {
        setSelectedObject(null);
        rerender();
      });
      canvas.on("object:modified", () => {
        if (!loadingRef.current) setSaved(false);
        updateLayers();
        snapshotRef.current();
        rerender();
      });
      canvas.on("object:added", () => {
        // Bulk loads have their own final refresh; don't rebuild the whole
        // layer list once per object in a template, undo or duplicate.
        if (loadingRef.current) return;
        setSaved(false);
        updateLayers();
        snapshotRef.current();
      });
      canvas.on("object:removed", (e: any) => {
        // Deleting a clip mid-preview would leave the controller driving a
        // detached object. Catching it here covers every delete path — the
        // Delete key, the properties panel, the layer list, replaceImage —
        // instead of needing a stop() call at each one.
        if (e?.target?.mediaType === "video") videoPreviewRef.current?.stop();
        if (loadingRef.current) return;
        setSaved(false);
        updateLayers();
        snapshotRef.current();
      });

      // Corner / center / edge snapping with alignment guides.
      cleanupSnap = installSnapping(canvas);
    })().catch(() => {
      if (!disposed) {
        setCanvasError(true);
        loadingRef.current = false;
      }
    });

    return () => {
      disposed = true;
      controller.abort();
      if (cleanupSnap) cleanupSnap();
      // Allow the next mount (reopen) to initialize a fresh canvas.
      initializedRef.current = false;
      // Dispose the canvas this invocation created (if the async init already
      // got that far). Guard against double-dispose of a shared ref.
      const created = localCanvas;
      if (created) {
        try {
          created.dispose();
        } catch {
          // ignore — canvas may already be torn down
        }
        if (fabricCanvasRef.current === created) {
          fabricCanvasRef.current = null;
        }
      }
      setCanvasReady(false);
    };
    // Read the initial document once per route; local size/metadata edits
    // must not dispose the canvas or clear its history.
  }, [template?.id, updateLayers, rerender, setSaved]);

  // Apply zoom via Fabric's native viewport (NOT a CSS transform). CSS-scaling
  // the canvas wrapper breaks in-canvas text editing (mis-positioned textarea /
  // caret) and shrinks the selection control handles along with everything else.
  // Native zoom keeps the design's logical coordinates intact while resizing the
  // on-screen canvas, so editing and the handles stay correct at any zoom.
  // `zoom` is fit-relative (100 = whole canvas visible), so the actual native
  // fraction passed to Fabric is `zoom` scaled by `fitPct`.
  // useLayoutEffect (not useEffect) so a pointer-anchored zoom (see the wheel
  // handler below) corrects scroll before paint — otherwise the canvas would
  // visibly jump to re-centered scroll for a frame before snapping back under
  // the cursor.
  useLayoutEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canvasReady) return;
    const w = template?.width || 1080;
    const h = template?.height || 1350;
    const requested = (zoom * fitPct) / 10000;
    const z = Math.min(
      requested,
      maxDisplayZoom(w, h, canvas.getRetinaScaling()),
    );
    if (z < requested - 1e-6) setZoom((z * 10000) / fitPct);
    canvas.setZoom(z);
    canvas.setDimensions({ width: w * z, height: h * z });
    canvas.requestRenderAll();

    const ws = workspaceRef.current;
    const wrapperEl = canvas.wrapperEl as HTMLElement | undefined;

    // If this change came from the wheel handler, it recorded which point on
    // the canvas was under the cursor. Re-measure that point now that the
    // resize above has been applied, and correct scroll so it lands back
    // under the cursor instead of the viewport re-centering on the canvas.
    // Otherwise (slider, +/- buttons, fit button) there's no cursor to anchor
    // to, so re-center the canvas — without this, zooming out via those
    // controls after a wheel-zoom left the view scrolled deep into the
    // canvas, so shrinking it back down (e.g. hitting "fit") left the now-
    // small canvas stranded in a corner instead of fully visible.
    const anchor = wheelZoomAnchorRef.current;
    if (anchor && ws && wrapperEl) {
      wheelZoomAnchorRef.current = null;
      const rect = wrapperEl.getBoundingClientRect();
      ws.scrollLeft += rect.left + anchor.fracX * rect.width - anchor.clientX;
      ws.scrollTop += rect.top + anchor.fracY * rect.height - anchor.clientY;
    } else if (ws) {
      ws.scrollLeft = (ws.scrollWidth - ws.clientWidth) / 2;
      ws.scrollTop = (ws.scrollHeight - ws.clientHeight) / 2;
    }
  }, [zoom, fitPct, canvasReady, template?.width, template?.height]);

  // Clicking anywhere in the workspace that isn't the canvas itself — the
  // surrounding scrollable background, or the padding around the canvas —
  // deselects whatever's active. Fabric only clears selection for empty
  // space it renders itself (inside the canvas); clicks that land outside
  // its DOM element entirely aren't seen by it at all.
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws || !canvasReady) return;

    const handleMouseDown = (e: MouseEvent) => {
      const canvas = fabricCanvasRef.current;
      const wrapperEl = canvas?.wrapperEl as HTMLElement | undefined;
      if (!canvas || !wrapperEl) return;
      if (wrapperEl.contains(e.target as Node)) return;
      if (canvas.getActiveObject()) {
        canvas.discardActiveObject();
        canvas.requestRenderAll();
      }
    };

    ws.addEventListener("mousedown", handleMouseDown);
    return () => ws.removeEventListener("mousedown", handleMouseDown);
  }, [canvasReady]);

  // Alt + mouse-wheel zoom, anchored to the cursor (the standard behavior in
  // design tools like Figma). Reads/writes Fabric's live zoom directly rather
  // than the React `zoom` state so rapid wheel ticks always compound on the
  // latest value instead of a stale render's closure.
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws || !canvasReady) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      // Non-passive listener (see addEventListener below) so this actually
      // suppresses the browser's own default for Alt+wheel (e.g. Firefox's
      // back/forward history navigation) instead of just being ignored.
      e.preventDefault();
      const canvas = fabricCanvasRef.current;
      const wrapperEl = canvas?.wrapperEl as HTMLElement | undefined;
      if (!canvas || !wrapperEl) return;

      const rect = wrapperEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      // Convert Fabric's live native zoom back to the displayed, fit-relative
      // percentage before applying the wheel delta to it.
      const curPct = (canvas.getZoom() * 10000) / fitPct;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nextPct = Math.min(
        MAX_ZOOM_PCT,
        Math.max(MIN_ZOOM_PCT, curPct * factor),
      );
      if (Math.abs(nextPct - curPct) < 0.01) return;

      // Fraction of the canvas's current on-screen box under the cursor —
      // deliberately not clamped to [0, 1]. Hovering just outside the canvas
      // still anchors correctly since the same linear mapping extrapolates.
      wheelZoomAnchorRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        fracX: (e.clientX - rect.left) / rect.width,
        fracY: (e.clientY - rect.top) / rect.height,
      };
      setZoom(nextPct);
    };

    ws.addEventListener("wheel", handleWheel, { passive: false });
    return () => ws.removeEventListener("wheel", handleWheel);
  }, [canvasReady, fitPct]);

  // The native "% of actual pixel size" zoom that makes the whole template
  // fit inside the workspace viewport (accounting for the p-16 = 64px padding
  // on each side). This is `fitPct` — the conversion factor for the displayed
  // fit-relative `zoom` above, so "100%" always means "whole canvas visible"
  // no matter the template's actual pixel dimensions.
  const computeFitZoom = useCallback(() => {
    const ws = workspaceRef.current;
    const w = template?.width || 1080;
    const h = template?.height || 1350;
    const availW =
      (ws?.clientWidth || 800) - ((ws?.clientWidth || 800) < 550 ? 48 : 96);
    const availH =
      (ws?.clientHeight || 600) - ((ws?.clientHeight || 600) < 530 ? 58 : 88);
    const fit = Math.min(availW / w, availH / h) * 100;
    return Math.max(1, fit);
  }, [template?.width, template?.height]);

  // Re-derive `fitPct` whenever the workspace resizes (window resize, sidebar
  // toggles, etc.) or the template changes, so a given `zoom` percentage keeps
  // meaning the same thing on screen instead of drifting when the available
  // space changes.
  useEffect(() => {
    if (!canvasReady) return;
    const recompute = () => setFitPct(computeFitZoom());
    recompute();
    const ws = workspaceRef.current;
    if (!ws || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(ws);
    return () => ro.disconnect();
  }, [canvasReady, computeFitZoom]);

  // Reset to "fit" whenever a different template is opened — `zoom` is state
  // on this component, which stays mounted across in-app template navigation
  // and would otherwise carry over the previous template's zoom level.
  const zoomedTemplateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canvasReady || !template?.id) return;
    if (zoomedTemplateRef.current === template.id) return;
    zoomedTemplateRef.current = template.id;
    setZoom(100);
  }, [canvasReady, template?.id]);

  // Own one preview controller per live canvas. Disposing it on teardown is
  // what stops the animation loop and releases the <video> elements (and their
  // network streams) when the editor unmounts or the canvas is rebuilt.
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvasReady || !canvas) return;

    const preview = new VideoPreview(canvas, setPreviewState, () =>
      toast.info(
        "Previewing muted — the browser blocked audible autoplay. The exported MP4 still carries its audio.",
      ),
    );
    videoPreviewRef.current = preview;

    return () => {
      preview.dispose();
      if (videoPreviewRef.current === preview) videoPreviewRef.current = null;
      setPreviewState({
        playing: false,
        time: 0,
        duration: 0,
        soloLayerId: null,
        ready: false,
      });
    };
  }, [canvasReady]);

  // Play / pause the whole composition, or one clip on its own when a layer id
  // is given. Called from the transport bar and the video properties panel.
  const togglePreview = useCallback((soloLayerId: string | null = null) => {
    const preview = videoPreviewRef.current;
    if (!preview) return;
    const state = preview.getState();
    if (state.playing && state.soloLayerId === soloLayerId) preview.pause();
    else preview.play(soloLayerId);
  }, []);

  // Save handler
  /**
   * The template's own output overrides, in the shape the API stores them:
   * image settings on `outputDefaults`, MP4 settings on `videoDefaults`.
   * Blank fields are omitted entirely so they keep inheriting the global
   * defaults rather than being frozen at whatever they happened to show.
   */
  const templateDefaultsPayload = useCallback(() => {
    const numberOrUndefined = (v: number | "" | undefined) =>
      v === "" || v === undefined ? undefined : Number(v);
    return {
      outputDefaults: {
        format: templateOutput.format || undefined,
        quality: numberOrUndefined(templateOutput.quality),
        scale: numberOrUndefined(templateOutput.scale),
      },
      videoDefaults: {
        fps: numberOrUndefined(templateOutput.fps),
        durationSec: numberOrUndefined(templateOutput.durationSec),
        crf: templateOutput.videoQuality
          ? videoQualityToCrf(templateOutput.videoQuality)
          : undefined,
      },
    };
  }, [templateOutput]);

  const persist = useCallback(
    async (copy = false, announce = true): Promise<boolean> => {
      const canvas = fabricCanvasRef.current,
        signal = lifetime.current?.signal;
      if (
        !canvas ||
        !canvasReady ||
        !signal ||
        signal.aborted ||
        loadingRef.current ||
        writeLock.current
      )
        return false;
      writeLock.current = true;
      setSaving(true);
      if (copy) setRestoring(true);
      let conflict = false;
      try {
        canvas.getActiveObject()?.exitEditing?.();
        stopVideoPreview();
        const atRevision = revision.current;
        const payload = {
          ...docInfo.current,
          designJson: canvas.toObject([...EXTRA_PROPS]),
          ...templateDefaultsPayload(),
          expectedVersion: serverVersion.current,
        };
        const response = await fetch(
          `/api/templates/${encodeURIComponent(templateId)}${copy ? "/duplicate" : ""}`,
          {
            method: copy ? "POST" : "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const row = await response.json().catch(() => null);
        if (!response.ok) {
          conflict = response.status === 409;
          throw new Error(
            conflict
              ? "Another tab saved a newer version. Save your edits as a copy, or reload the saved version."
              : response.status === 401
                ? "Your session expired. Sign in in another tab, then retry here."
                : response.status === 413
                  ? "This design is larger than the server accepts. Reduce the size of its images and retry."
                  : row?.error ||
                    "Could not save. Check your connection and retry; your edits are still here.",
          );
        }
        if (typeof row?.id !== "string" || !Number.isInteger(row.version))
          throw new Error(
            "Could not confirm the save. Keep this tab open and retry.",
          );
        void queryClient.invalidateQueries({ queryKey: ["templates"] });
        if (signal.aborted) return false;
        const unchanged = atRevision === revision.current;
        if (!copy) serverVersion.current = row.version;
        setSaveIssue(null);
        if (unchanged) setSaved(true);
        if (copy) {
          toast.success("Saved a separate copy. The original was not changed.");
          if (unchanged) navigate(`/editor/${row.id}`);
        } else if (announce)
          toast.success(
            unchanged
              ? "Design saved"
              : "Saved. Newer edits still need saving.",
          );
        return unchanged;
      } catch (e) {
        if (!signal.aborted)
          setSaveIssue({
            conflict: conflict || copy,
            message:
              e instanceof TypeError
                ? "Could not reach your workspace. Your edits are still here."
                : e instanceof Error
                  ? e.message
                  : "Could not save your design.",
          });
        return false;
      } finally {
        writeLock.current = false;
        if (!signal.aborted) {
          setSaving(false);
          if (copy) setRestoring(false);
        }
      }
    },
    [
      canvasReady,
      navigate,
      queryClient,
      setSaved,
      stopVideoPreview,
      templateDefaultsPayload,
      templateId,
    ],
  );
  const handleSave = useCallback(() => persist(), [persist]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        !canvasReady ||
        canvasError ||
        loadingRef.current ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      // Don't hijack keys while typing in a form field or editing text in-canvas
      // (Fabric routes in-canvas text through a hidden <textarea>).
      const tag = document.activeElement?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
        return;
      }

      if (typing || previewMode) return;
      if (!mod && !e.altKey) {
        if (e.key === "/") {
          e.preventDefault();
          setFocusMode(false);
          setPanel("Templates");
          const focusSearch = () =>
            document
              .querySelector<HTMLInputElement>(".sl-search input")
              ?.focus();
          if (document.querySelector(".sl-search input")) focusSearch();
          else requestAnimationFrame(focusSearch);
          return;
        }
        if (e.key.toLowerCase() === "v") setActiveTool("select");
        if (e.key.toLowerCase() === "h") setActiveTool("pan");
        if (e.key.toLowerCase() === "f") setFocusMode((f) => !f);
        if (e.key === "Escape") {
          setFocusMode(false);
          setActiveTool("select");
          fabricCanvasRef.current?.discardActiveObject();
          fabricCanvasRef.current?.requestRenderAll();
        }
      }
      // Undo / redo: ⌘Z / ⌘⇧Z (and ⌘Y for redo).
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }

      // Duplicate: ⌘D
      if (mod && e.key.toLowerCase() === "d") {
        if (typing) return;
        e.preventDefault();
        void duplicateSelected();
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (typing) return;
        const canvas = fabricCanvasRef.current;
        const active = canvas?.getActiveObject();
        if (active) {
          e.preventDefault();
          removeSelected();
        }
        return;
      }

      // Arrow-key nudge (1px, or 10px with Shift).
      if (
        !typing &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight")
      ) {
        const canvas = fabricCanvasRef.current;
        if (!canvas?.getActiveObject()) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowUp") nudgeSelected(0, -step);
        else if (e.key === "ArrowDown") nudgeSelected(0, step);
        else if (e.key === "ArrowLeft") nudgeSelected(-step, 0);
        else nudgeSelected(step, 0);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    canvasReady,
    canvasError,
    handleSave,
    undo,
    redo,
    duplicateSelected,
    removeSelected,
    nudgeSelected,
    previewMode,
  ]);

  const selectNew = useCallback((object: any) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || loadingRef.current || canvas.disposed) {
      object.dispose();
      return;
    }
    canvas.add(object);
    canvas.setActiveObject(object);
    canvas.requestRenderAll();
    setActiveTool("select");
    mobileClose();
  }, []);
  const addText = useCallback(
    async (kind: TextKind) => {
      const { Textbox } = await loadFabric();
      const { width: w, height: h } = docInfo.current;
      const [value, size, weight, style, font] = (
        {
          heading: ["Your headline", 0.09, "bold", "normal", "Arial"],
          subheading: ["Your subheading", 0.057, "bold", "normal", "Arial"],
          body: ["Add your text here", 0.039, "normal", "normal", "Arial"],
          editorial: [
            "Editorial italic",
            0.09,
            "normal",
            "italic",
            "Times New Roman",
          ],
          caption: ["STUDIO CAPTION", 0.03, "bold", "normal", "Courier New"],
        } as const
      )[kind];
      selectNew(
        new Textbox(value, {
          width: w * 0.72,
          left: w * 0.14,
          top: h * 0.44,
          fontSize: Math.max(10, Math.round(w * size)),
          fontWeight: weight,
          fontStyle: style,
          fontFamily: font,
          fill: "#192e38",
          name: kind,
          dynamic: false,
        }),
      );
    },
    [selectNew],
  );
  const addShape = useCallback(
    async (kind: ShapeKind) => {
      const f = await loadFabric();
      const { width: w, height: h } = docInfo.current;
      const size = Math.min(w, h) * 0.23;
      const properties = {
        left: w / 2 - size / 2,
        top: h / 2 - size / 2,
        fill: "#e77954",
        strokeWidth: 0,
        name: kind,
        dynamic: false,
      };
      const shape =
        kind === "line"
          ? new f.Line([w * 0.3, h * 0.5, w * 0.7, h * 0.5], {
              stroke: "#263f46",
              strokeWidth: Math.max(2, w * 0.005),
              name: "line",
              dynamic: false,
            })
          : kind === "circle"
            ? new f.Circle({ ...properties, radius: size / 2 })
            : kind === "triangle"
              ? new f.Triangle({ ...properties, width: size, height: size })
              : kind === "diamond"
                ? new f.Polygon(
                    [
                      { x: size / 2, y: 0 },
                      { x: size, y: size / 2 },
                      { x: size / 2, y: size },
                      { x: 0, y: size / 2 },
                    ],
                    properties,
                  )
                : new f.Rect({
                    ...properties,
                    width: size,
                    height: size * 0.76,
                  });
      selectNew(shape);
    },
    [selectNew],
  );
  const addGraphic = useCallback(
    async (src: string, name: string) => {
      try {
        const { FabricImage } = await loadFabric();
        const img = await FabricImage.fromURL(src, {
          crossOrigin: "anonymous",
        });
        // An SVG without intrinsic dimensions loads as 0×0; dividing by that
        // put scale: Infinity and left/top: NaN into the design.
        if (!(img.width > 0 && img.height > 0)) throw new Error("Image has no size");
        const { width: w, height: h } = docInfo.current;
        const scale = Math.min((w * 0.46) / img.width, (h * 0.46) / img.height);
        img.set({
          left: (w - img.width * scale) / 2,
          top: (h - img.height * scale) / 2,
          scaleX: scale,
          scaleY: scale,
          name,
          dynamic: false,
        });
        selectNew(img);
      } catch {
        toast.error("This image could not be opened. Try another file.");
      }
    },
    [selectNew],
  );
  const addImageFile = useCallback(
    (file: File) => {
      if (file.size > 10 * 1024 * 1024) {
        toast.error("Choose an image under 10 MB for this artboard.");
        return;
      }
      if (
        !["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(
          file.type,
        )
      ) {
        toast.error("Choose a PNG, JPG, WebP or SVG image.");
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => toast.error("Could not read that file");
      reader.onload = () =>
        void addGraphic(
          String(reader.result),
          file.name.replace(/\.[^.]+$/, ""),
        );
      reader.readAsDataURL(file);
    },
    [addGraphic],
  );
  const addImage = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) addImageFile(file);
    };
    input.click();
  }, [addImageFile]);

  const addVideo = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4,video/webm,video/quicktime";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      const canvas = fabricCanvasRef.current;
      if (!file || !canvas) return;

      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        const asset = await res.json().catch(() => ({ error: `Server returned HTTP ${res.status}` }));
        if (!res.ok) throw new Error(asset?.error || "Video upload failed");
        if (!asset.posterUrl)
          throw new Error("Video upload did not return a poster frame");

        const { FabricImage } = await loadFabric();
        const img = await FabricImage.fromURL(asset.posterUrl);
        if (canvas !== fabricCanvasRef.current || loadingRef.current) {
          img.dispose();
          return;
        }
        const maxW = (template?.width || 1080) * 0.5;
        const maxH = (template?.height || 1350) * 0.5;
        const scale = Math.min(
          maxW / (img.width || 1),
          maxH / (img.height || 1),
          1,
        );
        img.set({
          left: 50,
          top: 50,
          scaleX: scale,
          scaleY: scale,
          name: "",
          dynamic: false,
          mediaType: "video",
          src: asset.posterUrl,
          posterUrl: asset.posterUrl,
          assetId: asset.id,
          videoSrc: asset.url,
          videoDuration: asset.duration || 0,
          trimStart: 0,
          trimEnd: asset.duration || 0,
          startAt: 0,
          loop: true,
          muted: false,
          volume: 1,
          playbackRate: 1,
          fit: "cover",
          hasAudio: asset.hasAudio ?? false,
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.renderAll();
        updateLayers();
        setActiveTool("select");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to add video",
        );
      }
    };
    input.click();
    setActiveTool("select");
  }, [template, updateLayers]);

  const replaceImage = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    const activeObj = canvas?.getActiveObject();
    if (!canvas || !activeObj) return;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      if (file.size > 10 * 1024 * 1024) {
        toast.error("Choose an image under 10 MB for this artboard.");
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => toast.error("Could not read that image.");
      reader.onload = async (ev) => {
        const url = ev.target?.result as string;
        // Keep the same object, identity, stack position and rotation.
        const w = activeObj.getScaledWidth(),
          h = activeObj.getScaledHeight();
        try {
          if (fabricCanvasRef.current !== canvas || !canvas.contains(activeObj))
            return;
          await activeObj.setSrc(url);
          if (fabricCanvasRef.current !== canvas || !canvas.contains(activeObj))
            return;
          if (activeObj.width > 0 && activeObj.height > 0) {
            const scale = Math.min(w / activeObj.width, h / activeObj.height);
            if (Number.isFinite(scale) && scale > 0) activeObj.set({ scaleX: scale, scaleY: scale });
          } else {
            toast.error("The new image has no size; its dimensions could not be fitted.");
          }
          activeObj.setCoords();
          canvas.requestRenderAll();
          canvas.fire("object:modified", { target: activeObj });
        } catch {
          toast.error("Could not replace this image");
        }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, []);

  /**
   * Export dialog state.
   *
   * Only what the user changes inside the dialog is stored here; everything
   * else falls through to the resolved settings (global defaults → this
   * template's overrides), so Export no longer starts from its own private
   * png/100/2x that matched nothing else in the app.
   */
  const [exportOpen, setExportOpen] = useState(false);
  const [exportOverrides, setExportOverrides] = useState<OutputSettingsValue>(
    {},
  );

  // What the Output popover currently resolves to — the values a render of
  // this template will use, and the fallback for the Export dialog.
  const resolvedOutput = resolveOutputSettings(
    globalOutputDefaults,
    templateOutput as PartialOutputSettings,
  );
  const exportSettings = resolveOutputSettings(
    resolvedOutput,
    exportOverrides as PartialOutputSettings,
  );
  const requestedFormat = exportOverrides.format || exportSettings.format;
  const videoLayerCount = useMemo(
    () =>
      layers.reduce(
        (n, layer) =>
          n +
          (layer.mediaType === "video"
            ? 1
            : typeof layer.object.getObjects === "function"
              ? collectVideoObjects(layer.object).length
              : 0),
        0,
      ),
    [layers],
  );
  const hasVideoLayer = videoLayerCount > 0;
  const exportFormat =
    requestedFormat === "mp4" && !hasVideoLayer ? "png" : requestedFormat;
  const exportQuality = exportSettings.quality;
  const exportScale = exportSettings.scale;
  const exportFps = exportSettings.fps;
  const exportDuration =
    exportOverrides.durationSec ?? exportSettings.durationSec ?? "";
  const exportVideoQuality = exportSettings.videoQuality;

  // Render-time history, used for the "Est. time" readouts. Only MP4 export
  // goes through the server; PNG/JPG/WebP/SVG are drawn straight from the
  // canvas here and are effectively instant, so no estimate is offered for
  // them in the Export dialog.
  const { data: editorRenderStats } = useRenderStats();
  // The Output popover configures server-side renders (API / Automate), so an
  // estimate is meaningful there for stills as well as MP4.
  const outputEstimate = estimateRenderMs(editorRenderStats, {
    kind: resolvedOutput.format === "mp4" ? "video" : "image",
    templateId: template?.templateId,
    width: template?.width,
    height: template?.height,
    scale: resolvedOutput.scale,
    fps: resolvedOutput.fps,
    durationSec: resolvedOutput.durationSec,
  });
  const exportEstimate = estimateRenderMs(editorRenderStats, {
    kind: exportFormat === "mp4" ? "video" : "image",
    templateId: template?.templateId,
    width: template?.width,
    height: template?.height,
    scale: exportScale,
    fps: exportFps,
    durationSec: typeof exportDuration === "number" ? exportDuration : null,
  });

  const doExport = useCallback(async () => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canvasReady || loadingRef.current || writeLock.current)
      return;

    // A PNG/JPG export re-renders the canvas at export scale, and the MP4 path
    // toggles zoom around it — neither should race an animation loop that is
    // repainting the same canvas.
    stopVideoPreview();

    if (exportFormat === "mp4") {
      try {
        // Use precisely the same conditional and single-flight write as Save.
        // Never start a job for an older draft or silently overwrite another tab.
        if (!(await persist(false, false))) {
          setExportOpen(false);
          return;
        }
        const queuedRevision = revision.current;
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template_id: template?.templateId,
            format: "mp4",
            fps: exportFps,
            duration:
              exportDuration === "" ? undefined : Number(exportDuration),
            videoQuality: exportVideoQuality,
            scale: exportScale,
          }),
        });
        const data = await res.json().catch(() => ({ error: `Server returned HTTP ${res.status}` }));
        if (!res.ok)
          throw new Error(data?.error || "Failed to start MP4 export");
        if (lifetime.current?.signal.aborted) return;
        setExportOpen(false);
        if (queuedRevision === revision.current) {
          toast.success("MP4 export queued. Opening renders page…");
          navigate("/renders");
        } else
          toast.success("MP4 export queued. Your newer edits are still open.");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to export MP4",
        );
      }
      return;
    }

    const { width: w, height: h, name } = docInfo.current;
    const limit =
      exportFormat === "svg" ? null : rasterExportIssue(w, h, exportScale);
    if (limit) {
      toast.error(limit);
      return;
    }
    try {
      let blob: Blob | null;
      if (exportFormat === "svg") {
        // SVG dimensions affect gradients/patterns too. Temporarily use the
        // logical size, without allocating full-size DOM/Retina backstores.
        const old = {
          width: canvas.width,
          height: canvas.height,
          viewportTransform: canvas.viewportTransform,
        };
        let svg: string;
        try {
          canvas.set({
            width: w,
            height: h,
            viewportTransform: [1, 0, 0, 1, 0, 0],
          });
          svg = canvas.toSVG();
        } finally {
          canvas.set(old);
        }
        blob = new Blob(
          [await portableStorageImages(svg, lifetime.current?.signal)],
          { type: "image/svg+xml" },
        );
      } else {
        const format = exportFormat === "jpg" ? "jpeg" : exportFormat;
        // Render once into exactly the requested backing store. Fabric uses
        // canvas.width for sizing; a fractional display zoom would otherwise
        // round some exports down one pixel, so use integral logical units.
        const old = {
          width: canvas.width,
          height: canvas.height,
          viewportTransform: canvas.viewportTransform,
          enableRetinaScaling: canvas.enableRetinaScaling,
          skipControlsDrawing: canvas.skipControlsDrawing,
        };
        let encoded: Promise<Blob | null>;
        try {
          canvas.set({
            width: w,
            height: h,
            viewportTransform: [1, 0, 0, 1, 0, 0],
          });
          encoded = canvas.toBlob({
            format,
            quality: exportQuality / 100,
            multiplier: exportScale,
          });
        } finally {
          canvas.set(old);
          canvas.calcViewportBoundaries();
          canvas.requestRenderAll();
        }
        blob = await encoded;
        if (!blob || blob.type !== `image/${format}`)
          throw new Error("Encoder unavailable");
      }
      if (!blob || !blob.size || lifetime.current?.signal.aborted) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.download = `${name || "template"}.${exportFormat}`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch {
      toast.error(
        "Could not export this design. Try a smaller scale or check the images.",
      );
      return;
    }
    setExportOpen(false);
    toast.success(`Exported as ${exportFormat.toUpperCase()}`);
  }, [
    canvasReady,
    persist,
    exportFormat,
    exportQuality,
    exportScale,
    exportFps,
    exportDuration,
    exportVideoQuality,
    template?.templateId,
    navigate,
    stopVideoPreview,
  ]);

  // Update selected object property
  const updateProp = useCallback(
    // Pass a key + value, or an object of several properties to set at once
    // (one undo step — e.g. scaleX and scaleY when resizing with a locked ratio).
    (key: string | Record<string, any>, value?: any) => {
      const canvas = fabricCanvasRef.current;
      const obj = canvas?.getActiveObject();
      if (!obj || !canvas) return;
      if (typeof key === "string") obj.set(key as any, value);
      else obj.set(key);
      obj.setCoords();
      canvas.renderAll();
      snapshotRef.current();
      setSaved(false);
      updateLayers();
      rerender();
    },
    [updateLayers, rerender, setSaved],
  );

  // Apply a font family to the selected text object and re-measure it.
  const applyFont = useCallback(
    (family: string) => {
      const canvas = fabricCanvasRef.current;
      const obj = canvas?.getActiveObject();
      if (!canvas || !obj) return;
      obj.set("fontFamily", family);
      refreshTextFonts(canvas);
      snapshotRef.current();
      setSaved(false);
      updateLayers();
      rerender();
    },
    [updateLayers, rerender, setSaved],
  );

  // Load + register the project's uploaded custom fonts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fonts: CustomFont[] = await fetch("/api/fonts").then(async (r) =>
          r.ok ? (await r.json()).fonts : [],
        );
        if (cancelled || !fonts?.length) return;
        const available = await Promise.allSettled(
          fonts.map((f) => registerCustomFont(f.family, f.url)),
        );
        if (!cancelled) {
          setCustomFonts(
            fonts.filter((_, i) => available[i].status === "fulfilled"),
          );
          if (fabricCanvasRef.current)
            refreshTextFonts(fabricCanvasRef.current);
        }
      } catch {
        // ignore — custom fonts are optional
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Upload a custom font file, register it, and add it to the picker.
  const handleUploadFont = useCallback(
    async (file: File) => {
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/upload", {
          method: "POST",
          body: form,
        });
        const data = await res.json().catch(() => ({ error: `Server returned HTTP ${res.status}` }));
        if (!res.ok) throw new Error(data.error || "Font upload failed");
        const font: CustomFont = {
          family: (data.name || file.name).replace(/\.[^.]+$/, ""),
          url: data.url,
        };
        await registerCustomFont(font.family, font.url);
        setCustomFonts((prev) => [
          ...prev.filter((f) => f.family !== font.family),
          font,
        ]);
        applyFont(font.family);
        toast.success(`Added ${font.family}`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not upload font",
        );
      }
    },
    [applyFont],
  );

  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canvasReady) return;
    const moving = activeTool === "pan" || previewMode;
    canvas.skipTargetFind = moving;
    canvas.selection = !moving;
    canvas.defaultCursor = previewMode
      ? "default"
      : moving
        ? "grab"
        : "default";
    canvas.hoverCursor = moving ? canvas.defaultCursor : "move";
    if (moving) canvas.discardActiveObject();
    canvas.requestRenderAll();
  }, [activeTool, previewMode, canvasReady]);
  const changePreview = () => {
    stopVideoPreview();
    setPreviewMode((v) => !v);
    setActiveTool("select");
    setZoom(100);
  };
  useEffect(() => {
    if (!previewMode) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) {
        stopVideoPreview();
        setPreviewMode(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [previewMode, stopVideoPreview]);
  useEffect(() => {
    if (saved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved]);
  const leave = (path: string) => {
    if (saved || window.confirm("Leave without saving your changes?"))
      navigate(path);
  };
  const applyPreset = async () => {
    const p = pendingPreset,
      c = fabricCanvasRef.current;
    const signal = lifetime.current?.signal;
    if (!p || !c || !signal || !canvasReady || loadingRef.current || applying)
      return;
    loadingRef.current = true;
    setApplying(true);
    stopVideoPreview();
    try {
      const json = await presetDesign(p);
      await loadArtwork(c, json, signal);
      if (signal.aborted) return;
      docInfo.current = { name: p.name, width: p.width, height: p.height };
      setTemplateName(p.name);
      setDocSize({ width: p.width, height: p.height });
      setZoom(100);
      setActiveTool("select");
      setSelectedObject(null);
      updateLayers();
      c.requestRenderAll();
      setSaved(false);
      loadingRef.current = false;
      snapshotRef.current();
      setPendingPreset(null);
      mobileClose();
      toast.success("Template applied — undo to go back");
    } catch {
      if (!signal.aborted)
        toast.error("Could not apply this template. Your artwork was kept.");
    } finally {
      loadingRef.current = false;
      setApplying(false);
    }
  };
  const toggleLayer = (l: StudioLayer, prop: "visible" | "lock") => {
    const c = fabricCanvasRef.current;
    if (!c) return;
    if (prop === "visible") l.object.set("visible", !l.visible);
    else
      l.object.set({
        selectable: l.locked,
        evented: l.locked,
        hasControls: l.locked,
        hasBorders: l.locked,
        lockMovementX: !l.locked,
        lockMovementY: !l.locked,
      });
    if (c.getActiveObjects().includes(l.object)) c.discardActiveObject();
    c.renderAll();
    c.fire("object:modified", { target: l.object });
  };
  if (!template)
    return (
      <main className="sl-loading">
        {!readError ? (
          <>
            <Loader2 className="animate-spin" />
            Opening your studio…
          </>
        ) : (
          <>
            <h1>Design not available</h1>
            <p role="alert">{readError}</p>
            <button
              className="sl-secondary"
              onClick={() => setReadAttempt((n) => n + 1)}
            >
              Try again
            </button>
            <button className="sl-secondary" onClick={() => navigate("/")}>
              <ArrowLeft size={15} />
              Back to templates
            </button>
          </>
        )}
      </main>
    );
  const canvas = fabricCanvasRef.current,
    active = canvas?.getActiveObject();
  const currentPreset = STUDIO_PRESETS.find((p) =>
    layers.some((l) => l.id === `studio-${p.id}-art`),
  );
  const seen = new Set<string>();
  const usedImages =
    panel === "Uploads"
      ? layers.flatMap((l) => {
          if (l.type !== "image" || l.mediaType === "video") return [];
          const src = l.object.getSrc();
          if (!src || seen.has(src)) return [];
          seen.add(src);
          return [{ name: l.name, src }];
        })
      : [];
  const inspect = () => showPanel("Properties");
  const setClampedZoom = (v: number) =>
    setZoom(Math.min(MAX_ZOOM_PCT, Math.max(MIN_ZOOM_PCT, v)));
  const background =
    typeof canvas?.backgroundColor === "string"
      ? canvas.backgroundColor
      : "#ffffff";
  return (
    <>
      <div
        inert={!canvasReady || restoring}
        aria-busy={!canvasReady || restoring}
        className={`sl-editor ${previewMode ? "sl-preview-mode" : ""} ${focusMode ? "sl-focus-mode" : ""}`}
      >
        <StudioHeader
          name={templateName}
          rename={(v) => {
            docInfo.current.name = v;
            setTemplateName(v);
            setSaved(false);
            snapshotRef.current();
          }}
          save={handleSave}
          saved={saved}
          saving={saving}
          undo={undo}
          redo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          preview={changePreview}
          exportDesign={() => setExportOpen(true)}
          settings={() => setModal("settings")}
          home={() => leave("/")}
          copyId={() => {
            if (!navigator.clipboard) {
              window.prompt("Copy template ID", template.templateId);
              return;
            }
            void navigator.clipboard.writeText(template.templateId).then(
              () => toast.success("Template ID copied"),
              () => window.prompt("Copy template ID", template.templateId),
            );
          }}
          automate={() => leave(`/playground?template=${template.templateId}`)}
          isPreview={previewMode}
        />
        {saveIssue && (
          <div className="sl-save-issue" role="alert">
            <span>{saveIssue.message}</span>
            {saveIssue.conflict ? (
              <>
                <button disabled={saving} onClick={() => void persist(true)}>
                  Save as copy
                </button>
                <button
                  disabled={saving}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Discard your local edits and load the latest saved version?",
                      )
                    ) {
                      window.location.reload();
                    }
                  }}
                >
                  Reload latest
                </button>
              </>
            ) : (
              <button disabled={saving} onClick={() => void handleSave()}>
                Retry save
              </button>
            )}
          </div>
        )}
        <div className="sl-workspace">
          {!previewMode && !focusMode && (
            <>
              <StudioRail
                panel={panel}
                choose={choosePanel}
                settings={() => setModal("settings")}
                help={() => setModal("help")}
              />
              {panel && (
                <>
                  <button
                    className="sl-mobile-scrim"
                    aria-label="Dismiss tool panel"
                    onClick={() => setPanel(null)}
                  />
                  <AssetPanel panel={panel} close={() => setPanel(null)}>
                    {panel === "Templates" ? (
                      <TemplateLibrary
                        current={currentPreset?.id}
                        choose={setPendingPreset}
                      />
                    ) : panel === "Elements" ? (
                      <ElementLibrary
                        addShape={addShape}
                        addGraphic={addGraphic}
                      />
                    ) : panel === "Text" ? (
                      <TextLibrary add={addText} />
                    ) : panel === "Uploads" ? (
                      <UploadLibrary
                        addImage={addImage}
                        addVideo={addVideo}
                        used={usedImages}
                        insert={addGraphic}
                        drop={addImageFile}
                      />
                    ) : panel === "Layers" ? (
                      <LayerLibrary
                        layers={layers}
                        active={active}
                        select={(l) => {
                          setActiveTool("select");
                          canvas?.setActiveObject(l.object);
                          canvas?.requestRenderAll();
                          rerender();
                        }}
                        toggle={toggleLayer}
                        reorder={reorderLayers}
                        inspect={inspect}
                      />
                    ) : (
                      <Inspector
                        object={active}
                        update={updateProp}
                        fonts={customFonts}
                        applyFont={applyFont}
                        uploadFont={handleUploadFont}
                        replace={replaceImage}
                        remove={removeSelected}
                        duplicate={duplicateSelected}
                        align={alignSelected}
                        showLayers={() => showPanel("Layers")}
                        videoCount={videoLayerCount}
                        preview={previewState}
                        soloAll={previewAllLayers}
                        setSoloAll={setPreviewAllLayers}
                        play={togglePreview}
                        stop={stopVideoPreview}
                        seek={(t) => videoPreviewRef.current?.seek(t)}
                      />
                    )}
                  </AssetPanel>
                </>
              )}
            </>
          )}
          <main className="sl-stage" aria-label="Design canvas">
            {!previewMode && (
              <StageToolbar
                mode={activeTool}
                setMode={setActiveTool}
                active={active}
                bg={background}
                setBg={(v) => {
                  canvas.backgroundColor = v;
                  canvas.requestRenderAll();
                  setSaved(false);
                  snapshotRef.current();
                  rerender();
                }}
                resize={() => setModal("resize")}
                inspect={inspect}
                layers={() => showPanel("Layers")}
                update={updateProp}
                align={alignSelected}
                duplicate={duplicateSelected}
                remove={removeSelected}
                settings={() => setModal("settings")}
                help={() => setModal("help")}
                openPanel={() => showPanel("Templates")}
                undo={undo}
                redo={redo}
                canUndo={canUndo}
                canRedo={canRedo}
              />
            )}
            <div
              className={`sl-scroll ${activeTool === "pan" ? "is-panning" : ""}`}
              ref={workspaceRef}
              onPointerDownCapture={(e) => {
                if (activeTool !== "pan" || previewMode) return;
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                panOrigin.current = {
                  x: e.clientX,
                  y: e.clientY,
                  left: e.currentTarget.scrollLeft,
                  top: e.currentTarget.scrollTop,
                };
              }}
              onPointerMoveCapture={(e) => {
                const a = panOrigin.current;
                if (!a) return;
                e.currentTarget.scrollLeft = a.left + a.x - e.clientX;
                e.currentTarget.scrollTop = a.top + a.y - e.clientY;
              }}
              onPointerUpCapture={() => {
                panOrigin.current = null;
              }}
              onLostPointerCapture={() => {
                panOrigin.current = null;
              }}
            >
              <div className="sl-bed">
                <div
                  className="sl-artboard"
                  style={{ visibility: canvasReady ? "visible" : "hidden" }}
                >
                  <div className="sl-art-label">
                    <span>
                      <b>01</b> Artboard
                    </span>
                    <small>
                      {template.width} × {template.height} px
                    </small>
                  </div>
                  <div className="sl-paper">
                    <canvas
                      ref={canvasRef}
                      aria-label="Editable design artboard"
                    />
                  </div>
                </div>
              </div>
            </div>
            {!previewMode && (
              <div className="sl-canvas-tip">
                <MouseTip /> Double-click text to edit <i /> Drag to move
              </div>
            )}
            <StageFooter
              zoom={zoom}
              fit={fitPct}
              change={setClampedZoom}
              focus={focusMode}
              toggleFocus={() =>
                previewMode ? changePreview() : setFocusMode((v) => !v)
              }
              preview={previewMode}
              help={() => setModal("help")}
            >
              {hasVideoLayer && (
                <div className="sl-transport">
                  <IconButton
                    label={
                      previewState.playing ? "Pause timeline" : "Play timeline"
                    }
                    action={() => togglePreview(null)}
                  >
                    {previewState.playing ? (
                      <Pause size={14} />
                    ) : (
                      <Play size={14} />
                    )}
                  </IconButton>
                  <IconButton label="Stop timeline" action={stopVideoPreview}>
                    <RotateCcw size={13} />
                  </IconButton>
                  <span>{formatClock(previewState.time)}</span>
                </div>
              )}
            </StageFooter>
          </main>
        </div>
      </div>
      {(!canvasReady || restoring) && (
        <div
          className="sl-loading sl-blocker"
          role={canvasError ? "alert" : "status"}
        >
          {canvasError ? (
            <>
              <h1>Could not open the artwork</h1>
              <p>Your saved design has not been changed.</p>
              <button
                className="sl-secondary"
                onClick={() => location.reload()}
              >
                Try again
              </button>
              <button className="sl-link" onClick={() => navigate("/")}>
                Back to templates
              </button>
            </>
          ) : (
            <>
              <Loader2 className="animate-spin" />
              {restoring ? "Updating your workspace…" : "Preparing artboard…"}
            </>
          )}
        </div>
      )}
      <PresetDialog
        preset={pendingPreset}
        close={() => {
          if (!applying) setPendingPreset(null);
        }}
        apply={applyPreset}
        busy={applying}
      />
      <StudioDialog
        open={modal === "resize"}
        close={() => setModal(null)}
        title="Resize artboard"
        description="Choose the dimensions of your design."
        kicker="ARTBOARD SETTINGS"
      >
        {modal === "resize" && (
          <ResizeForm
            width={template.width}
            height={template.height}
            resize={(w, h) => {
              docInfo.current = { ...docInfo.current, width: w, height: h };
              setDocSize({ width: w, height: h });
              setZoom(100);
              setSaved(false);
              snapshotRef.current();
              setModal(null);
            }}
          />
        )}
      </StudioDialog>
      <StudioDialog
        open={modal === "settings"}
        close={() => setModal(null)}
        title="Output settings"
        description="Choose defaults for this design, or inherit your workspace settings."
        kicker="STUDIO SETTINGS"
        wide
      >
        <OutputSettingsFields
          allowInherit
          allowVideo={hasVideoLayer}
          inherited={globalOutputDefaults}
          value={templateOutput}
          onChange={(patch) => {
            setTemplateOutput((prev) => ({ ...prev, ...patch }));
            setSaved(false);
          }}
        />
        <div className="sl-setting-summary">
          <strong>
            {resolvedOutput.format.toUpperCase()} · {resolvedOutput.scale}×
          </strong>
          <span>
            {template.width * resolvedOutput.scale} ×{" "}
            {template.height * resolvedOutput.scale} px
          </span>
        </div>
        <p className="sl-fine" title={describeEstimate(outputEstimate)}>
          Estimated render time: {formatEta(outputEstimate.ms)}
        </p>
        <button
          className="sl-primary sl-fill"
          onClick={() => {
            setModal(null);
            void handleSave();
          }}
        >
          Save settings
        </button>
      </StudioDialog>
      <StudioDialog
        open={modal === "help"}
        close={() => setModal(null)}
        title="Studio shortcuts"
        description="A few shortcuts to keep your hands on the canvas."
        kicker="QUICK REFERENCE"
      >
        <HelpContent />
      </StudioDialog>
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        exportFormat={exportFormat}
        setExportFormat={(format) =>
          setExportOverrides((prev) => ({ ...prev, format }))
        }
        exportQuality={exportQuality}
        setExportQuality={(quality) =>
          setExportOverrides((prev) => ({ ...prev, quality }))
        }
        exportScale={exportScale}
        setExportScale={(scale) =>
          setExportOverrides((prev) => ({ ...prev, scale }))
        }
        exportFps={exportFps}
        setExportFps={(fps) => setExportOverrides((prev) => ({ ...prev, fps }))}
        exportDuration={exportDuration}
        setExportDuration={(durationSec) =>
          setExportOverrides((prev) => ({ ...prev, durationSec }))
        }
        exportVideoQuality={exportVideoQuality}
        setExportVideoQuality={(videoQuality) =>
          setExportOverrides((prev) => ({ ...prev, videoQuality }))
        }
        canvasHasVideo={hasVideoLayer}
        templateWidth={template?.width || 1080}
        templateHeight={template?.height || 1350}
        estimateLabel={
          exportFormat === "mp4" ? formatEta(exportEstimate.ms) : null
        }
        estimateTitle={describeEstimate(exportEstimate)}
        sizeLabel={
          exportFormat === "mp4" || exportFormat === "svg"
            ? null
            : estimateOutputSizeLabel({
                width: template?.width || 1080,
                height: template?.height || 1350,
                scale: exportScale,
                format: exportFormat,
                quality: exportQuality,
                design: template?.designJson,
              })
        }
        validationIssue={
          exportFormat === "svg"
            ? null
            : rasterExportIssue(template.width, template.height, exportScale)
        }
        saving={saving}
        onExport={doExport}
      />
    </>
  );
}
function MouseTip() {
  return <Sparkles size={12} strokeWidth={1.7} />;
}
