"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn, copyToClipboard } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { installSnapping } from "@/lib/editor/snapping";
import { ensureFont, registerCustomFont } from "@/lib/editor/font-loader";
import { EXTRA_PROPS } from "@/lib/editor/serialized-props";
import { VideoPreview, type VideoPreviewState } from "@/lib/editor/video-preview";
import { FontPicker, type CustomFont } from "@/components/editor/font-picker";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Save,
  Pencil,
  Download,
  Zap,
  ChevronLeft,
  Type,
  Image as ImageIcon,
  Video,
  Square,
  Upload,
  Eye,
  EyeOff,
  Trash2,
  Copy,
  GripVertical,
  Minus,
  Undo2,
  Redo2,
  Loader2,
  Circle,
  Triangle,
  Play,
  Pause,
  RotateCcw,
  Minus as LineIcon,
  MousePointer,
  SlidersHorizontal,
  Lock,
  Unlock,
  Maximize2,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
} from "lucide-react";

// We'll store the fabric module reference once loaded
let fabricModule: typeof import("fabric") | null = null;

const HISTORY_PROPS = [...EXTRA_PROPS];

async function loadFabric() {
  if (fabricModule) return fabricModule;
  fabricModule = await import("fabric");
  return fabricModule;
}

// After a web font loads or a font changes, Fabric keeps a stale per-family
// glyph-metric cache and stale object caches, so text keeps rendering in the
// fallback font. Clear the font cache, re-measure every text object, and
// repaint (twice, to cover the next frame once glyphs are ready).
function refreshTextFonts(canvas: any) {
  if (!canvas) return;
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
    requestAnimationFrame(() => canvas.renderAll());
  }
}

/** Seconds as m:ss.d, for the video playback readout. */
function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs.toFixed(1)}`;
}

export default function EditorPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const templateId = params.templateId as string;

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

  const [selectedObject, setSelectedObject] = useState<any>(null);
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
  const [saved, setSaved] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [templateName, setTemplateName] = useState("Untitled");
  const [layers, setLayers] = useState<any[]>([]);
  const [activeTool, setActiveTool] = useState<string>("select");
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
  // Layer drag-and-drop reordering state.
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

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
  const HISTORY_LIMIT = 80;
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

  // Fetch template
  const { data: template, isLoading, isError } = useQuery({
    queryKey: ["template", templateId],
    queryFn: async () => {
      const res = await fetch(`/api/templates/${templateId}`);
      if (!res.ok) throw new Error("Failed to load template");
      return res.json();
    },
    // Always refetch the latest saved design when the editor (re)mounts, so
    // reopening after a save shows the saved state — not a stale cache. The
    // init effect only runs once per mount (see initializedRef), so the
    // post-mount refetch won't clobber in-progress edits.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/templates/${templateId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: (_data, variables: any) => {
      setSaved(true);
      setSaving(false);
      // Keep the cached template in sync with what we just saved, so reopening
      // the editor (client-side navigation) shows the saved design instead of a
      // stale cache. Also refresh the templates list cache.
      queryClient.setQueryData(["template", templateId], (old: any) =>
        old ? { ...old, ...variables } : old
      );
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template saved");
    },
    onError: () => {
      toast.error("Failed to save template");
      setSaving(false);
    },
  });

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
      })
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
      [...panel]
        .reverse()
        .forEach((l, i) => canvas.moveObjectTo(l.object, i));
      canvas.renderAll();
      setSaved(false);
      updateLayers();
      rerender();
    },
    [layers, updateLayers, rerender]
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
    const json = JSON.stringify(canvas.toObject(HISTORY_PROPS));
    if (h.stack[h.index] === json) return;
    // Drop any redo tail, append, and cap the stack length.
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(json);
    if (h.stack.length > HISTORY_LIMIT) h.stack.shift();
    h.index = h.stack.length - 1;
    setCanUndo(h.index > 0);
    setCanRedo(false);
  }, []);
  // Keep the ref current so canvas event handlers call the latest version.
  snapshotRef.current = pushHistory;

  const restoreHistory = useCallback(
    async (json: string) => {
      const canvas = fabricCanvasRef.current;
      if (!canvas) return;
      // loadFromJSON below replaces every object on the canvas, so a running
      // preview would be left driving detached ones.
      stopVideoPreview();
      const h = historyRef.current;
      h.restoring = true;
      loadingRef.current = true;
      try {
        await canvas.loadFromJSON(JSON.parse(json));
        canvas.renderAll();
      } finally {
        loadingRef.current = false;
        h.restoring = false;
      }
      setSelectedObject(null);
      setSaved(false);
      updateLayers();
      rerender();
    },
    [updateLayers, rerender, stopVideoPreview]
  );

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    setCanUndo(h.index > 0);
    setCanRedo(h.index < h.stack.length - 1);
    restoreHistory(h.stack[h.index]);
  }, [restoreHistory]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    setCanUndo(h.index > 0);
    setCanRedo(h.index < h.stack.length - 1);
    restoreHistory(h.stack[h.index]);
  }, [restoreHistory]);

  // Clone the selected object (offset a little so it's visible) and select it.
  const duplicateSelected = useCallback(async () => {
    const canvas = fabricCanvasRef.current;
    const active = canvas?.getActiveObject();
    if (!canvas || !active) return;
    const cloned = await active.clone(HISTORY_PROPS);
    // Give the clone its own identity so layer keys / history stay consistent.
    cloned.set({
      left: (active.left || 0) + 16,
      top: (active.top || 0) + 16,
      id: undefined,
    });
    canvas.add(cloned);
    canvas.setActiveObject(cloned);
    canvas.renderAll();
    setSelectedObject(cloned);
    rerender();
  }, [rerender]);

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
  const alignSelected = useCallback(
    (mode: "left" | "centerH" | "right" | "top" | "middle" | "bottom") => {
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

      const sel = active.getBoundingRect();

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

        if (dx || dy) {
          const p = obj.getXY();
          obj.setXY(new fabricModule.Point(p.x + dx, p.y + dy));
          obj.setCoords();
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
    []
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
    let localCanvas: any = null;
    let cleanupSnap: (() => void) | null = null;
    loadingRef.current = true;

    (async () => {
      const fabric = await loadFabric();
      if (disposed || !canvasRef.current) return;

      const { Canvas, FabricImage, util } = fabric;
      const canvas = new Canvas(canvasRef.current, {
        width: template.width || 1080,
        height: template.height || 1350,
        backgroundColor:
          template.designJson?.background || "#ffffff",
        preserveObjectStacking: true,
        selection: true,
      });

      localCanvas = canvas;
      fabricCanvasRef.current = canvas;
      setTemplateName(template.name || "Untitled");
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

      // Load existing design
      if (template.designJson?.objects?.length > 0) {
        await canvas.loadFromJSON(template.designJson);
        if (!disposed) {
          canvas.renderAll();
          updateLayers();
          loadingRef.current = false;
          setSaved(true);
          setCanvasReady(true);
          // Seed the undo baseline with the freshly loaded design.
          historyRef.current = { stack: [], index: -1, restoring: false };
          snapshotRef.current();
          setCanUndo(false);
          setCanRedo(false);
          // Scroll workspace to center the canvas
          requestAnimationFrame(() => {
            const ws = workspaceRef.current;
            if (ws) {
              ws.scrollLeft = (ws.scrollWidth - ws.clientWidth) / 2;
              ws.scrollTop = (ws.scrollHeight - ws.clientHeight) / 2;
            }
          });
          // Load any non-system fonts used in the design, then repaint so the
          // text renders with the correct typeface.
          const families = new Set<string>();
          for (const o of canvas.getObjects()) {
            if ((o as any).fontFamily) families.add((o as any).fontFamily);
          }
          families.forEach((f) =>
            ensureFont(f).then(() => !disposed && refreshTextFonts(canvas))
          );
        }
      } else {
        loadingRef.current = false;
        setCanvasReady(true);
        // Seed the undo baseline with the empty canvas.
        historyRef.current = { stack: [], index: -1, restoring: false };
        snapshotRef.current();
        setCanUndo(false);
        setCanRedo(false);
        requestAnimationFrame(() => {
          const ws = workspaceRef.current;
          if (ws) {
            ws.scrollLeft = (ws.scrollWidth - ws.clientWidth) / 2;
            ws.scrollTop = (ws.scrollHeight - ws.clientHeight) / 2;
          }
        });
      }

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
        if (!loadingRef.current) setSaved(false);
        updateLayers();
        snapshotRef.current();
      });
      canvas.on("object:removed", (e: any) => {
        // Deleting a clip mid-preview would leave the controller driving a
        // detached object. Catching it here covers every delete path — the
        // Delete key, the properties panel, the layer list, replaceImage —
        // instead of needing a stop() call at each one.
        if (e?.target?.mediaType === "video") videoPreviewRef.current?.stop();
        if (!loadingRef.current) setSaved(false);
        updateLayers();
        snapshotRef.current();
      });

      // Corner / center / edge snapping with alignment guides.
      cleanupSnap = installSnapping(canvas);
    })();

    return () => {
      disposed = true;
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
    // Keyed on the template's IDENTITY, never the query object.
    //
    // `template` used to be a dependency, which quietly defeated the
    // initializedRef guard above: the cleanup resets that ref and disposes the
    // canvas, so every change to the query object's reference — a background
    // refetch, and above all the setQueryData in saveMutation.onSuccess — tore
    // the live canvas down and rebuilt it. Saving therefore dropped the
    // selection and wiped the whole undo stack. The effect only ever READS the
    // template (to size the canvas and load its design), so it takes the
    // latest one from templateRef instead and re-runs only when a genuinely
    // different template is opened.
  }, [template?.id, updateLayers, rerender]);

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
    const z = (zoom / 100) * (fitPct / 100);
    const w = template?.width || 1080;
    const h = template?.height || 1350;
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
        Math.max(MIN_ZOOM_PCT, curPct * factor)
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
    const availW = (ws?.clientWidth || 800) - 128;
    const availH = (ws?.clientHeight || 600) - 128;
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
        "Previewing muted — the browser blocked audible autoplay. The exported MP4 still carries its audio."
      )
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
  const togglePreview = useCallback(
    (soloLayerId: string | null = null) => {
      const preview = videoPreviewRef.current;
      if (!preview) return;
      const state = preview.getState();
      if (state.playing && state.soloLayerId === soloLayerId) preview.pause();
      else preview.play(soloLayerId);
    },
    []
  );

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

  const handleSave = useCallback(async () => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    // Not strictly required — the preview deliberately leaves no trace in
    // toObject() — but a save is a natural resting point, and stopping here
    // means the thumbnail the server regenerates depicts the poster frames the
    // design actually stores.
    stopVideoPreview();
    setSaving(true);

    // Fabric's toJSON crashes ("Cannot read properties of undefined (reading
    // '0')") if a text object's `styles` is undefined — which happens for text
    // loaded from saved JSON that has no styles key. Ensure it's a valid object.
    for (const o of canvas.getObjects() as any[]) {
      if (
        /text|textbox|i-text/i.test(o.type || "") &&
        (!o.styles || typeof o.styles !== "object")
      ) {
        o.styles = {};
      }
    }

    for (const o of canvas.getObjects() as any[]) {
      if (o.mediaType === "video" && /^blob:|^data:video/.test(o.getSrc?.() || "")) {
        const poster = o.posterUrl || o.src;
        if (poster && typeof o.setSrc === "function") await o.setSrc(poster);
      }
    }

    const json = canvas.toObject([...EXTRA_PROPS]);

    saveMutation.mutate({
      name: templateName,
      designJson: json,
      width: template?.width,
      height: template?.height,
      ...templateDefaultsPayload(),
    });
  }, [templateName, template, saveMutation, templateDefaultsPayload, stopVideoPreview]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
          canvas.remove(active);
          setSelectedObject(null);
          canvas.discardActiveObject();
          canvas.renderAll();
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
  }, [handleSave, undo, redo, duplicateSelected, nudgeSelected]);

  // Tool actions — all use the already-loaded fabric module
  const addText = useCallback(async () => {
    const { Textbox } = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const text = new Textbox("Edit this text", {
      left: 100,
      top: 100,
      width: 300,
      fontSize: 32,
      fontFamily: "Arial",
      fill: "#000000",
      name: "",
      dynamic: false,
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    canvas.renderAll();
    setActiveTool("select");
  }, []);

  const addRect = useCallback(async () => {
    const { Rect } = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const rect = new Rect({
      left: 100,
      top: 100,
      width: 200,
      height: 150,
      fill: "#3b82f6",
      rx: 8,
      ry: 8,
      name: "",
    });
    canvas.add(rect);
    canvas.setActiveObject(rect);
    canvas.renderAll();
    setActiveTool("select");
  }, []);

  const addCircle = useCallback(async () => {
    const { Circle: FabricCircle } = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const circle = new FabricCircle({
      left: 100,
      top: 100,
      radius: 80,
      fill: "#10b981",
      name: "",
    });
    canvas.add(circle);
    canvas.setActiveObject(circle);
    canvas.renderAll();
    setActiveTool("select");
  }, []);

  const addTriangle = useCallback(async () => {
    const { Triangle: FabricTriangle } = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const triangle = new FabricTriangle({
      left: 100,
      top: 100,
      width: 150,
      height: 130,
      fill: "#f59e0b",
      name: "",
    });
    canvas.add(triangle);
    canvas.setActiveObject(triangle);
    canvas.renderAll();
    setActiveTool("select");
  }, []);

  const addLine = useCallback(async () => {
    const { Line } = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const line = new Line([50, 100, 300, 100], {
      stroke: "#000000",
      strokeWidth: 3,
      name: "",
    });
    canvas.add(line);
    canvas.setActiveObject(line);
    canvas.renderAll();
    setActiveTool("select");
  }, []);

  const addImage = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      const canvas = fabricCanvasRef.current;
      if (!file || !canvas) return;

      const { FabricImage } = await loadFabric();
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const url = ev.target?.result as string;
        const img = await FabricImage.fromURL(url);
        // Scale to fit ~50% of canvas
        const maxW = (template?.width || 1080) * 0.5;
        const maxH = (template?.height || 1350) * 0.5;
        const scale = Math.min(maxW / (img.width || 1), maxH / (img.height || 1), 1);
        img.set({
          left: 50,
          top: 50,
          scaleX: scale,
          scaleY: scale,
          name: "",
          dynamic: false,
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.renderAll();
      };
      reader.readAsDataURL(file);
    };
    input.click();
    setActiveTool("select");
  }, [template]);

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
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        const asset = await res.json();
        if (!res.ok) throw new Error(asset?.error || "Video upload failed");
        if (!asset.posterUrl) throw new Error("Video upload did not return a poster frame");

        const { FabricImage } = await loadFabric();
        const img = await FabricImage.fromURL(asset.posterUrl);
        const maxW = (template?.width || 1080) * 0.5;
        const maxH = (template?.height || 1350) * 0.5;
        const scale = Math.min(maxW / (img.width || 1), maxH / (img.height || 1), 1);
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
        toast.error(error instanceof Error ? error.message : "Failed to add video");
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

      const { FabricImage } = await loadFabric();
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const url = ev.target?.result as string;
        const newImg = await FabricImage.fromURL(url);
        // Preserve position, scale, name, dynamic flag
        const props = {
          left: activeObj.left,
          top: activeObj.top,
          scaleX: activeObj.scaleX,
          scaleY: activeObj.scaleY,
          angle: activeObj.angle,
          name: (activeObj as any).name || "",
          dynamic: (activeObj as any).dynamic ?? false,
          opacity: activeObj.opacity,
        };
        // Scale new image to fit the same bounding box
        const oldW = (activeObj.width || 1) * (activeObj.scaleX || 1);
        const oldH = (activeObj.height || 1) * (activeObj.scaleY || 1);
        const fitScale = Math.min(
          oldW / (newImg.width || 1),
          oldH / (newImg.height || 1)
        );
        newImg.set({
          ...props,
          scaleX: fitScale,
          scaleY: fitScale,
        });
        canvas.remove(activeObj);
        canvas.add(newImg);
        canvas.setActiveObject(newImg);
        canvas.renderAll();
        setSelectedObject(newImg);
        rerender();
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [rerender]);

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
    {}
  );

  // What the Output popover currently resolves to — the values a render of
  // this template will use, and the fallback for the Export dialog.
  const resolvedOutput = resolveOutputSettings(
    globalOutputDefaults,
    templateOutput as PartialOutputSettings
  );
  const exportSettings = resolveOutputSettings(
    resolvedOutput,
    exportOverrides as PartialOutputSettings
  );
  const exportFormat = exportOverrides.format || exportSettings.format;
  const exportQuality = exportSettings.quality;
  const exportScale = exportSettings.scale;
  const exportFps = exportSettings.fps;
  const exportDuration = exportOverrides.durationSec ?? "";
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
    if (!canvas) return;

    // A PNG/JPG export re-renders the canvas at export scale, and the MP4 path
    // toggles zoom around it — neither should race an animation loop that is
    // repainting the same canvas.
    stopVideoPreview();

    if (exportFormat === "mp4") {
      try {
        const json = canvas.toObject([...EXTRA_PROPS]);
        const saveRes = await fetch(`/api/templates/${template?.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: templateName,
            designJson: json,
            width: template?.width,
            height: template?.height,
            ...templateDefaultsPayload(),
          }),
        });
        if (!saveRes.ok) throw new Error("Failed to save template before MP4 export");
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template_id: template?.templateId,
            format: "mp4",
            fps: exportFps,
            duration: exportDuration === "" ? undefined : Number(exportDuration),
            videoQuality: exportVideoQuality,
            scale: exportScale,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to start MP4 export");
        setExportOpen(false);
        toast.success("MP4 export queued. Opening renders page…");
        router.push("/renders");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to export MP4");
      }
      return;
    }

    // The editor zooms via Fabric's viewport, so temporarily reset to 1:1 at
    // full template dimensions before exporting, then restore the editor zoom.
    // Otherwise the export would come out at the on-screen (zoomed) size.
    const w = template?.width || 1080;
    const h = template?.height || 1350;
    const z = (zoom / 100) * (fitPct / 100);
    canvas.setZoom(1);
    canvas.setDimensions({ width: w, height: h });
    canvas.renderAll();

    try {
      if (exportFormat === "svg") {
        const svg = canvas.toSVG();
        const blob = new Blob([svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.download = `${templateName || "template"}.svg`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } else {
        // The dialog speaks the app's format names (jpg); Fabric's toDataURL
        // only knows the MIME spelling (jpeg).
        const dataURL = canvas.toDataURL({
          format: (exportFormat === "jpg" ? "jpeg" : exportFormat) as any,
          quality: exportQuality / 100,
          multiplier: exportScale,
        });
        const link = document.createElement("a");
        link.download = `${templateName || "template"}.${exportFormat}`;
        link.href = dataURL;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } finally {
      // Restore the on-screen editor zoom.
      canvas.setZoom(z);
      canvas.setDimensions({ width: w * z, height: h * z });
      canvas.requestRenderAll();
    }
    setExportOpen(false);
    toast.success(`Exported as ${exportFormat.toUpperCase()}`);
  }, [templateName, exportFormat, exportQuality, exportScale, exportFps, exportDuration, exportVideoQuality, zoom, fitPct, template, templateDefaultsPayload, router, stopVideoPreview]);

  // Update selected object property
  const updateProp = useCallback(
    (key: string, value: any) => {
      const canvas = fabricCanvasRef.current;
      const obj = canvas?.getActiveObject();
      if (!obj || !canvas) return;
      obj.set(key as any, value);
      canvas.renderAll();
      setSaved(false);
      updateLayers();
      rerender();
    },
    [updateLayers, rerender]
  );

  // Apply a font family to the selected text object and re-measure it.
  const applyFont = useCallback(
    (family: string) => {
      const canvas = fabricCanvasRef.current;
      const obj = canvas?.getActiveObject();
      if (!canvas || !obj) return;
      obj.set("fontFamily", family);
      refreshTextFonts(canvas);
      setSaved(false);
      updateLayers();
      rerender();
    },
    [updateLayers, rerender]
  );

  // Get current property from the active object on the canvas (not stale state)
  const getProp = useCallback((key: string, fallback?: any) => {
    const canvas = fabricCanvasRef.current;
    const obj = canvas?.getActiveObject();
    if (!obj) return fallback;
    return (obj as any)[key] ?? fallback;
  }, []);

  // Load + register the project's uploaded custom fonts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fonts");
        if (!res.ok) return;
        const { fonts } = await res.json();
        if (cancelled || !fonts?.length) return;
        await Promise.all(
          fonts.map((f: CustomFont) => registerCustomFont(f.family, f.url))
        );
        if (!cancelled) {
          setCustomFonts(fonts);
          fabricCanvasRef.current?.requestRenderAll();
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
  const handleUploadFont = useCallback(async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Font upload failed");
      return;
    }
    const data = await res.json();
    const family = (data.name || file.name).replace(/\.[^.]+$/, "");
    await registerCustomFont(family, data.url);
    setCustomFonts((prev) =>
      prev.some((f) => f.family === family)
        ? prev
        : [...prev, { family, url: data.url }]
    );
    // Apply immediately to the selected text object, if any.
    applyFont(family);
    toast.success(`Font "${family}" added`);
  }, [applyFont]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f1115]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-[#8b919c]" />
          <p className="text-sm text-[#8b919c]">Loading editor…</p>
        </div>
      </div>
    );
  }

  if (isError || !template) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f1115]">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
            <Trash2 className="h-6 w-6 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#e6e8ec]">Template not found</h2>
            <p className="text-sm text-[#8b919c] mt-1">
              This template may have been deleted or you don&apos;t have access.
            </p>
          </div>
          <Button
            onClick={() => router.push("/")}
            className="bg-[#2f6fde] hover:bg-[#2561c7] text-white"
          >
            <ChevronLeft className="mr-2 h-4 w-4" />
            Back to Templates
          </Button>
        </div>
      </div>
    );
  }

  const toolItems = [
    {
      id: "select",
      icon: MousePointer,
      label: "Select",
      action: () => setActiveTool("select"),
    },
    { id: "text", icon: Type, label: "Text", action: addText },
    { id: "image", icon: ImageIcon, label: "Image", action: addImage },
    { id: "video", icon: Video, label: "Video", action: addVideo },
    { id: "rect", icon: Square, label: "Rect", action: addRect },
    { id: "circle", icon: Circle, label: "Circle", action: addCircle },
    {
      id: "triangle",
      icon: Triangle,
      label: "Triangle",
      action: addTriangle,
    },
    { id: "line", icon: LineIcon, label: "Line", action: addLine },
  ];

  const activeObj = fabricCanvasRef.current?.getActiveObject();
  const objType = (activeObj?.type || "").toLowerCase();
  const isText =
    objType === "textbox" || objType === "text" || objType === "i-text";
  const isVideo = objType === "image" && (activeObj as any)?.mediaType === "video";
  const isImage = objType === "image" && !isVideo;
  // How the preview controller identifies this layer — same fallback chain it
  // uses (see VideoPreview.layerId). Empty until updateLayers has stamped an
  // id on the object, which disables the solo-play button until then.
  const activeLayerId = isVideo
    ? (activeObj as any)?.id || (activeObj as any)?.name || ""
    : "";
  const isShape =
    objType === "rect" ||
    objType === "circle" ||
    objType === "triangle" ||
    objType === "ellipse" ||
    objType === "polygon" ||
    objType === "line";
  const isMultiSelect = objType === "activeselection";
  const videoLayerCount =
    fabricCanvasRef.current
      ?.getObjects()
      .filter((o: any) => o.type === "image" && o.mediaType === "video").length ?? 0;
  const canvasHasVideo = videoLayerCount > 0;
  // The switch is only offered for multi-clip designs, so a stale `true` left
  // over from before a clip was deleted must not keep forcing composed mode.
  const previewAll = previewAllLayers && videoLayerCount > 1;
  // True when the running preview is the one this panel's play button started,
  // so the button shows Pause for it and Play for everything else.
  const isPreviewingThisLayer =
    previewState.playing &&
    previewState.soloLayerId === (previewAll ? null : activeLayerId);

  const alignButtons: Array<{
    mode: "left" | "centerH" | "right" | "top" | "middle" | "bottom";
    icon: typeof AlignStartVertical;
    label: string;
  }> = [
    { mode: "left", icon: AlignStartVertical, label: "Align left" },
    { mode: "centerH", icon: AlignCenterVertical, label: "Align center" },
    { mode: "right", icon: AlignEndVertical, label: "Align right" },
    { mode: "top", icon: AlignStartHorizontal, label: "Align top" },
    { mode: "middle", icon: AlignCenterHorizontal, label: "Align middle" },
    { mode: "bottom", icon: AlignEndHorizontal, label: "Align bottom" },
  ];

  return (
    <>
    <TooltipProvider delayDuration={0}>
      <div
        className="flex flex-col h-screen bg-[#0f1115] text-[#e6e8ec] overflow-hidden"
        style={{
          "--background": "220 20% 7%",
          "--foreground": "220 10% 92%",
          "--card": "220 20% 7%",
          "--card-foreground": "220 10% 92%",
          "--popover": "220 18% 10%",
          "--popover-foreground": "220 10% 92%",
          "--primary": "217 91% 59%",
          "--primary-foreground": "220 10% 92%",
          "--secondary": "220 15% 16%",
          "--secondary-foreground": "220 10% 92%",
          "--muted": "220 15% 16%",
          "--muted-foreground": "220 10% 65%",
          "--accent": "220 15% 16%",
          "--accent-foreground": "220 10% 92%",
          "--destructive": "0 63% 31%",
          "--destructive-foreground": "220 10% 92%",
          "--border": "220 15% 20%",
          "--input": "220 15% 20%",
          "--ring": "224 76% 48%",
        } as React.CSSProperties}
      >
        {/* ==================== TOP BAR ==================== */}
        <div className="h-12 bg-[#14171c] border-b border-white/[0.08] flex items-center px-3 gap-2 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => router.push("/")}
                className="text-[#8b919c] hover:text-[#e6e8ec] hover:bg-[#23262c]"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back to Templates</TooltipContent>
          </Tooltip>

          <Logo size={28} className="rounded-md shrink-0" />

          <Separator
            orientation="vertical"
            className="h-5 bg-white/[0.08] mx-1"
          />

          {/* File menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="hover:bg-[#23262c] text-xs"
                style={{ color: "#c4c9d2" }}
              >
                File
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="border-white/[0.1]"
              style={{ backgroundColor: "#14171c", color: "#e6e8ec" }}
            >
              <DropdownMenuItem
                className="text-xs focus:bg-[#23262c]"
                style={{ color: "inherit" }}
                onClick={() => {
                  copyToClipboard(template?.templateId || "");
                  toast.success("Template ID copied");
                }}
              >
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy template ID
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-white/[0.08]" />
              <DropdownMenuItem
                className="text-xs focus:bg-[#23262c]"
                style={{ color: "inherit" }}
                onClick={handleSave}
              >
                <Save className="mr-2 h-3.5 w-3.5" />
                Save
                <span className="ml-auto text-[10px]" style={{ color: "#8b919c" }}>
                  ⌘S
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs focus:bg-[#23262c]"
                style={{ color: "inherit" }}
                onClick={() => setExportOpen(true)}
              >
                <Download className="mr-2 h-3.5 w-3.5" />
                Export Image
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Separator
            orientation="vertical"
            className="h-5 bg-white/[0.08] mx-1"
          />

          {/* Template name */}
          <div className="flex items-center gap-2 min-w-0">
            {editingName ? (
              <Input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setEditingName(false);
                }}
                className="h-7 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec] w-48"
                autoFocus
              />
            ) : (
              <button
                onClick={() => setEditingName(true)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[#23262c] text-xs text-[#c4c9d2]"
              >
                <span className="truncate max-w-[180px]">
                  {templateName}
                </span>
                <Pencil className="h-3 w-3 text-[#8b919c]" />
              </button>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <button className="text-[10px] text-[#8b919c] font-mono hover:text-white transition-colors cursor-pointer group flex items-center gap-1">
                  {template?.width} × {template?.height}
                  <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-64 p-4 border-white/10"
                style={{ backgroundColor: "#14171c", color: "#e6e8ec" }}
              >
                <h4 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "#c4c9d2" }}>
                  Canvas Size
                </h4>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="space-y-1.5">
                    <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                      Width (px)
                    </Label>
                    <Input
                      type="number"
                      defaultValue={template?.width}
                      className="h-8 text-xs bg-[#0f1115] border-white/10"
                      id="canvas-width-input"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                      Height (px)
                    </Label>
                    <Input
                      type="number"
                      defaultValue={template?.height}
                      className="h-8 text-xs bg-[#0f1115] border-white/10"
                      id="canvas-height-input"
                    />
                  </div>
                </div>
                <Button
                  size="sm"
                  className="w-full h-8 text-xs bg-white text-black hover:bg-white/90"
                  onClick={() => {
                    const w = parseInt(
                      (document.getElementById("canvas-width-input") as HTMLInputElement).value
                    );
                    const h = parseInt(
                      (document.getElementById("canvas-height-input") as HTMLInputElement).value
                    );
                    if (w > 0 && h > 0) {
                      fabricCanvasRef.current?.setWidth(w);
                      fabricCanvasRef.current?.setHeight(h);
                      fabricCanvasRef.current?.renderAll();
                      queryClient.setQueryData(["template", templateId], { ...template, width: w, height: h });
                      setSaved(false);
                      document.dispatchEvent(new MouseEvent("mousedown")); // Close popover trick
                    }
                  }}
                >
                  Apply Resize
                </Button>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className="hover:bg-[#23262c] text-xs gap-1.5"
            style={{ color: "#e0a13a" }}
            onClick={() =>
              router.push(
                `/playground?template=${template?.templateId}`
              )
            }
          >
            <Zap className="h-3.5 w-3.5" />
            Automate
          </Button>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="hover:bg-[#23262c] text-xs gap-1.5"
                style={{ color: "#c4c9d2" }}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Output
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-80 p-4 border-white/10"
              style={{
                backgroundColor: "#14171c",
                color: "#e6e8ec",
              }}
            >
              <h4 className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "#c4c9d2" }}>
                Output Settings
              </h4>
              <p className="text-[10px] mb-3" style={{ color: "#8b919c" }}>
                Overrides for this template. Anything left on the global default
                follows Settings → Output Settings.
              </p>
              {/* Same component, same options and same precedence as the
                  Settings screen and the Playground. */}
              <OutputSettingsFields
                dark
                allowInherit
                allowVideo={canvasHasVideo}
                inherited={globalOutputDefaults}
                value={templateOutput}
                onChange={(patch) => {
                  setTemplateOutput((prev) => ({ ...prev, ...patch }));
                  setSaved(false);
                }}
              />
              <div className="mt-3 space-y-1">
                <p className="text-[10px]" style={{ color: "#8b919c" }}>
                  Renders as: {resolvedOutput.format.toUpperCase()} ·{" "}
                  {resolvedOutput.scale}x ·{" "}
                  {(template?.width || 1080) * resolvedOutput.scale} ×{" "}
                  {(template?.height || 1350) * resolvedOutput.scale}px
                </p>
                {resolvedOutput.format !== "mp4" && (
                  <p className="text-[10px]" style={{ color: "#8b919c" }}>
                    Est. size:{" "}
                    {estimateOutputSizeLabel({
                      width: template?.width || 1080,
                      height: template?.height || 1350,
                      scale: resolvedOutput.scale,
                      format: resolvedOutput.format,
                      quality: resolvedOutput.quality,
                      design: template?.designJson,
                    })}
                  </p>
                )}
                <p
                  className="text-[10px]"
                  style={{ color: "#8b919c" }}
                  title={describeEstimate(outputEstimate)}
                >
                  Est. render time: {formatEta(outputEstimate.ms)}
                  {outputEstimate.basis === "estimate" ? " (rough)" : ""}
                </p>
              </div>
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setExportOpen(true)}
                style={{ color: "#c4c9d2" }}
                className="hover:bg-[#23262c]"
              >
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export Image</TooltipContent>
          </Tooltip>

          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="text-xs h-8 bg-[#2f6fde] hover:bg-[#2561c7] text-white"
          >
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* ==================== LEFT TOOL RAIL ==================== */}
          <div className="w-[58px] bg-[#14171c] border-r border-white/[0.08] flex flex-col items-center py-3 gap-1 shrink-0">
            {toolItems.map((tool) => (
              <Tooltip key={tool.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={tool.action}
                    className={cn(
                      "w-10 h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors",
                      activeTool === tool.id
                        ? "bg-[#2f6fde]/20 text-[#2f6fde]"
                        : "text-[#8b919c] hover:text-[#e6e8ec] hover:bg-[#23262c]"
                    )}
                  >
                    <tool.icon className="h-4 w-4" />
                    <span className="text-[9px] leading-none">
                      {tool.label}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{tool.label}</TooltipContent>
              </Tooltip>
            ))}
          </div>

          {/* ==================== CANVAS WORKSPACE ==================== */}
          <div
            ref={workspaceRef}
            className="flex-1 overflow-auto bg-[#0f1115] relative"
            style={{ overflowAnchor: "none" }}
          >
            <div className="min-h-full flex items-center justify-center p-16">
              {/* Zoom is applied via Fabric's viewport (see the zoom effect),
                  so the canvas element itself is already sized for the zoom —
                  no CSS transform here. */}
              <div className="relative shadow-2xl">
                <canvas ref={canvasRef} />
              </div>
            </div>
          </div>

          {/* ==================== RIGHT SIDEBAR ==================== */}
          <div className="w-[260px] bg-[#14171c] border-l border-white/[0.08] flex flex-col shrink-0">
            {/* Properties panel */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-white/[0.08]">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-[#c4c9d2] uppercase tracking-wider">
                    Properties
                  </h3>
                  {activeObj && (
                    <span className="text-[10px] text-[#8b919c] font-mono">
                      {isMultiSelect ? "multiple" : objType}
                    </span>
                  )}
                </div>
              </div>

              <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                  {!activeObj ? (
                    <p className="text-xs text-[#8b919c] text-center py-8">
                      Select a layer to edit properties
                    </p>
                  ) : isMultiSelect ? (
                    <>
                      <p className="text-[11px] text-[#8b919c]">
                        {activeObj.getObjects().length} objects selected
                      </p>

                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-[#c4c9d2]">
                          Align
                        </Label>
                        <div className="grid grid-cols-3 gap-1">
                          {alignButtons.map(({ mode, icon: Icon, label }) => (
                            <Tooltip key={mode}>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => alignSelected(mode)}
                                  className="h-8 rounded-md flex items-center justify-center bg-[#1f232a] text-[#c4c9d2] hover:bg-[#23262c] hover:text-[#e6e8ec] transition-colors"
                                >
                                  <Icon className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>{label}</TooltipContent>
                            </Tooltip>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Field name */}
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-[#c4c9d2]">
                          Field Name
                        </Label>
                        <Input
                          value={getProp("name", "")}
                          onChange={(e) =>
                            updateProp("name", e.target.value)
                          }
                          placeholder="e.g. headline"
                          className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec] font-mono"
                        />
                      </div>

                      {/* Dynamic toggle */}
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] text-[#c4c9d2]">
                          Dynamic (API modifiable)
                        </Label>
                        <Switch
                          checked={getProp("dynamic", false)}
                          onCheckedChange={(v) => {
                            updateProp("dynamic", v);
                            // Auto-assign field name if toggling ON and name is empty
                            if (v && !getProp("name", "")) {
                              const canvas = fabricCanvasRef.current;
                              const type = (activeObj?.type || "layer").toLowerCase();
                              const count = canvas
                                ? canvas.getObjects().filter(
                                    (o: any) =>
                                      (o.type || "").toLowerCase() === type
                                  ).length
                                : 1;
                              const autoName = `${type}_${count}`;
                              updateProp("name", autoName);
                            }
                          }}
                          className="data-[state=checked]:bg-[#1d9e75]"
                        />
                      </div>

                      <Separator className="bg-white/[0.06]" />

                      {/* Text properties */}
                      {isText && (
                        <>
                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Font Family
                            </Label>
                            <FontPicker
                              value={getProp("fontFamily", "Arial")}
                              customFonts={customFonts}
                              onChange={applyFont}
                              onUpload={handleUploadFont}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1.5">
                              <Label className="text-[11px] text-[#c4c9d2]">
                                Size
                              </Label>
                              <Input
                                type="number"
                                value={getProp("fontSize", 32)}
                                onChange={(e) =>
                                  updateProp(
                                    "fontSize",
                                    Number(e.target.value)
                                  )
                                }
                                min={1}
                                className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-[11px] text-[#c4c9d2]">
                                Weight
                              </Label>
                              <Select
                                value={String(
                                  getProp("fontWeight", "normal")
                                )}
                                onValueChange={(v) =>
                                  updateProp("fontWeight", v)
                                }
                              >
                                <SelectTrigger className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-[#14171c] border-white/[0.1] text-[#e6e8ec]">
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
                                  ].map((w) => (
                                    <SelectItem
                                      key={w}
                                      value={w}
                                      className="text-xs focus:bg-[#23262c]"
                                    >
                                      {w}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Color
                            </Label>
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                value={
                                  getProp("fill", "#000000") || "#000000"
                                }
                                onChange={(e) =>
                                  updateProp("fill", e.target.value)
                                }
                                className="w-8 h-8 rounded-md border border-white/[0.1] cursor-pointer bg-transparent"
                              />
                              <Input
                                value={getProp("fill", "#000000")}
                                onChange={(e) =>
                                  updateProp("fill", e.target.value)
                                }
                                className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec] font-mono"
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Alignment
                            </Label>
                            <div className="flex gap-1">
                              {(["left", "center", "right"] as const).map(
                                (align) => (
                                  <button
                                    key={align}
                                    onClick={() =>
                                      updateProp("textAlign", align)
                                    }
                                    className={cn(
                                      "flex-1 h-8 rounded-md text-xs capitalize transition-colors",
                                      getProp("textAlign", "left") ===
                                        align
                                        ? "bg-[#2f6fde] text-white"
                                        : "bg-[#1f232a] text-[#c4c9d2] hover:bg-[#23262c]"
                                    )}
                                  >
                                    {align}
                                  </button>
                                )
                              )}
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Opacity
                            </Label>
                            <div className="flex items-center gap-3">
                              <Slider
                                value={[
                                  Math.round(getProp("opacity", 1) * 100),
                                ]}
                                onValueChange={([v]) =>
                                  updateProp("opacity", v / 100)
                                }
                                max={100}
                                step={1}
                                className="flex-1"
                              />
                              <span className="text-xs text-[#8b919c] font-mono w-8 text-right">
                                {Math.round(getProp("opacity", 1) * 100)}%
                              </span>
                            </div>
                          </div>
                        </>
                      )}

                      {/* Shape properties */}
                      {isShape && (
                        <>
                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Fill Color
                            </Label>
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                value={
                                  getProp("fill", "#3b82f6") || "#3b82f6"
                                }
                                onChange={(e) =>
                                  updateProp("fill", e.target.value)
                                }
                                className="w-8 h-8 rounded-md border border-white/[0.1] cursor-pointer bg-transparent"
                              />
                              <Input
                                value={getProp("fill", "#3b82f6")}
                                onChange={(e) =>
                                  updateProp("fill", e.target.value)
                                }
                                className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec] font-mono"
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Stroke
                            </Label>
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                value={
                                  getProp("stroke", "#000000") || "#000000"
                                }
                                onChange={(e) =>
                                  updateProp("stroke", e.target.value)
                                }
                                className="w-8 h-8 rounded-md border border-white/[0.1] cursor-pointer bg-transparent"
                              />
                              <Input
                                type="number"
                                value={getProp("strokeWidth", 0)}
                                onChange={(e) =>
                                  updateProp(
                                    "strokeWidth",
                                    Number(e.target.value)
                                  )
                                }
                                placeholder="Width"
                                className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec] w-16"
                              />
                            </div>
                          </div>

                          {objType === "rect" && (
                            <div className="space-y-1.5">
                              <Label className="text-[11px] text-[#c4c9d2]">
                                Corner Radius
                              </Label>
                              <Input
                                type="number"
                                value={getProp("rx", 0)}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  updateProp("rx", v);
                                  updateProp("ry", v);
                                }}
                                min={0}
                                className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]"
                              />
                            </div>
                          )}

                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Opacity
                            </Label>
                            <div className="flex items-center gap-3">
                              <Slider
                                value={[
                                  Math.round(getProp("opacity", 1) * 100),
                                ]}
                                onValueChange={([v]) =>
                                  updateProp("opacity", v / 100)
                                }
                                max={100}
                                step={1}
                                className="flex-1"
                              />
                              <span className="text-xs text-[#8b919c] font-mono w-8 text-right">
                                {Math.round(getProp("opacity", 1) * 100)}%
                              </span>
                            </div>
                          </div>
                        </>
                      )}

                      {/* Video properties */}
                      {isVideo && (
                        <>
                          <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-[11px] text-[#c4c9d2]">
                            <div className="flex items-center justify-between gap-2">
                              <span>Video layer</span>
                              <span className="font-mono text-[#8b919c]">
                                {Number(getProp("videoDuration", 0) || 0).toFixed(1)}s
                              </span>
                            </div>
                          </div>

                          {/* ---- Playback --------------------------------
                              Plays the real clip on the canvas (the layer
                              otherwise only ever shows its poster frame), so
                              the trim and timing settings below can be checked
                              without waiting on a full MP4 render.

                              Previewing "this clip" starts the timeline at the
                              layer's own `Start at`, so a clip that appears
                              late doesn't mean staring at an empty canvas
                              first. The `All layers` switch (offered only when
                              there is more than one clip to compose) runs the
                              whole timeline from 0 instead — the only way to
                              check how several clips line up. */}
                          <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 space-y-2">
                            <div className="flex items-center gap-1.5">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="h-7 w-7 shrink-0 text-[#e6e8ec] hover:bg-[#23262c] disabled:opacity-40"
                                    onClick={() =>
                                      togglePreview(previewAll ? null : activeLayerId)
                                    }
                                    disabled={!activeLayerId}
                                  >
                                    {isPreviewingThisLayer ? (
                                      <Pause className="h-3.5 w-3.5" />
                                    ) : (
                                      <Play className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {isPreviewingThisLayer ? "Pause" : "Play on canvas"}
                                </TooltipContent>
                              </Tooltip>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="h-7 w-7 shrink-0 text-[#8b919c] hover:text-[#e6e8ec] hover:bg-[#23262c] disabled:opacity-40"
                                    onClick={stopVideoPreview}
                                    disabled={previewState.duration === 0}
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Stop and show the poster frame</TooltipContent>
                              </Tooltip>

                              <Slider
                                value={[previewState.time]}
                                onValueChange={([v]) => videoPreviewRef.current?.seek(v)}
                                min={0}
                                max={previewState.duration || 1}
                                step={0.05}
                                disabled={previewState.duration === 0}
                                className="flex-1 mx-1"
                              />
                            </div>

                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-[#8b919c]">
                                {previewState.duration === 0
                                  ? "Not playing"
                                  : previewAll
                                  ? "Whole timeline"
                                  : "This clip"}
                              </span>
                              <span className="font-mono tabular-nums text-[#8b919c]">
                                {formatClock(previewState.time)} /{" "}
                                {formatClock(
                                  previewState.duration ||
                                    Math.max(
                                      0,
                                      Number(getProp("trimEnd", getProp("videoDuration", 0))) -
                                        Number(getProp("trimStart", 0))
                                    )
                                )}
                              </span>
                            </div>

                            {videoLayerCount > 1 && (
                              <div className="flex items-center justify-between pt-0.5">
                                <Label className="text-[11px] text-[#c4c9d2]">
                                  Preview all layers
                                </Label>
                                <Switch
                                  checked={previewAll}
                                  onCheckedChange={(v) => {
                                    stopVideoPreview();
                                    setPreviewAllLayers(v);
                                  }}
                                />
                              </div>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1.5">
                              <Label className="text-[11px] text-[#c4c9d2]">Trim start</Label>
                              <Input
                                type="number"
                                min={0}
                                step={0.1}
                                value={getProp("trimStart", 0)}
                                onChange={(e) => updateProp("trimStart", Math.max(0, Number(e.target.value) || 0))}
                                className="h-8 bg-[#121418] border-white/[0.08] text-xs"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-[11px] text-[#c4c9d2]">Trim end</Label>
                              <Input
                                type="number"
                                min={0}
                                step={0.1}
                                value={getProp("trimEnd", getProp("videoDuration", 0))}
                                onChange={(e) => updateProp("trimEnd", Math.max(0, Number(e.target.value) || 0))}
                                className="h-8 bg-[#121418] border-white/[0.08] text-xs"
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1.5">
                              <Label className="text-[11px] text-[#c4c9d2]">Start at</Label>
                              <Input
                                type="number"
                                min={0}
                                step={0.1}
                                value={getProp("startAt", 0)}
                                onChange={(e) => updateProp("startAt", Math.max(0, Number(e.target.value) || 0))}
                                className="h-8 bg-[#121418] border-white/[0.08] text-xs"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-[11px] text-[#c4c9d2]">Fit</Label>
                              <Select value={getProp("fit", "cover")} onValueChange={(v) => updateProp("fit", v)}>
                                <SelectTrigger className="h-8 bg-[#121418] border-white/[0.08] text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="cover">Cover</SelectItem>
                                  <SelectItem value="contain">Contain</SelectItem>
                                  <SelectItem value="stretch">Stretch</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <div className="flex items-center justify-between">
                            <Label className="text-[11px] text-[#c4c9d2]">Loop</Label>
                            <Switch checked={!!getProp("loop", true)} onCheckedChange={(v) => updateProp("loop", v)} />
                          </div>
                          <div className="flex items-center justify-between">
                            <Label className="text-[11px] text-[#c4c9d2]">Muted</Label>
                            <Switch checked={!!getProp("muted", false)} disabled={!getProp("hasAudio", false)} onCheckedChange={(v) => updateProp("muted", v)} />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">Volume</Label>
                            <Slider
                              value={[Math.round((getProp("volume", 1) || 0) * 100)]}
                              onValueChange={([v]) => updateProp("volume", v / 100)}
                              min={0}
                              max={200}
                              step={1}
                              disabled={!getProp("hasAudio", false) || !!getProp("muted", false)}
                            />
                          </div>
                        </>
                      )}

                      {/* Image properties */}
                      {isImage && (
                        <>
                          <div className="space-y-1.5">
                            <Label className="text-[11px] text-[#c4c9d2]">
                              Opacity
                            </Label>
                            <div className="flex items-center gap-3">
                              <Slider
                                value={[
                                  Math.round(getProp("opacity", 1) * 100),
                                ]}
                                onValueChange={([v]) =>
                                  updateProp("opacity", v / 100)
                                }
                                max={100}
                                step={1}
                                className="flex-1"
                              />
                              <span className="text-xs text-[#8b919c] font-mono w-8 text-right">
                                {Math.round(getProp("opacity", 1) * 100)}%
                              </span>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-xs hover:bg-[#23262c]"
                            style={{ color: "#c4c9d2" }}
                            onClick={replaceImage}
                          >
                            <Upload className="mr-2 h-3.5 w-3.5" />
                            Replace Image
                          </Button>
                        </>
                      )}

                      <Separator className="bg-white/[0.06]" />

                      {/* Delete */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-xs hover:bg-red-500/10"
                        style={{ color: "#f87171" }}
                        onClick={() => {
                          const canvas = fabricCanvasRef.current;
                          const obj = canvas?.getActiveObject();
                          if (obj && canvas) {
                            canvas.remove(obj);
                            canvas.discardActiveObject();
                            canvas.renderAll();
                            setSelectedObject(null);
                          }
                        }}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete Layer
                      </Button>
                    </>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Layers panel */}
            <div className="border-t border-white/[0.08] flex flex-col h-[280px]">
              <div className="px-4 py-3 border-b border-white/[0.08]">
                <h3 className="text-xs font-semibold text-[#c4c9d2] uppercase tracking-wider">
                  Layers
                </h3>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2">
                  {layers.length === 0 ? (
                    <p className="text-xs text-[#8b919c] text-center py-6">
                      No layers yet — add objects using the tool rail
                    </p>
                  ) : (
                    layers.map((layer, idx) => (
                      <div
                        key={layer.id}
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(e) => {
                          dragIndexRef.current = idx;
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", String(idx));
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dragOverIdx !== idx) setDragOverIdx(idx);
                        }}
                        onDragLeave={() => {
                          if (dragOverIdx === idx) setDragOverIdx(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const from = dragIndexRef.current;
                          if (from != null) reorderLayers(from, idx);
                          dragIndexRef.current = null;
                          setDragOverIdx(null);
                        }}
                        onDragEnd={() => {
                          dragIndexRef.current = null;
                          setDragOverIdx(null);
                        }}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors group cursor-pointer",
                          activeObj === layer.object
                            ? "bg-[#2f6fde]/20"
                            : "hover:bg-[#23262c]",
                          dragOverIdx === idx &&
                            "ring-1 ring-[#2f6fde] ring-inset"
                        )}
                        onClick={() => {
                          const canvas = fabricCanvasRef.current;
                          if (canvas) {
                            canvas.setActiveObject(layer.object);
                            canvas.renderAll();
                            setSelectedObject(layer.object);
                            rerender();
                          }
                        }}
                      >
                        <GripVertical className="h-3 w-3 text-[#8b919c] opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0" />

                        <div
                          className={cn(
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            layer.dynamic && layer.name
                              ? "bg-[#1d9e75]"
                              : "bg-transparent"
                          )}
                        />

                        {layer.type === "textbox" ||
                        layer.type === "text" ||
                        layer.type === "i-text" ? (
                          <Type className="h-3.5 w-3.5 text-[#8b919c] shrink-0" />
                        ) : layer.type === "image" && layer.mediaType === "video" ? (
                          <Video className="h-3.5 w-3.5 text-[#8b919c] shrink-0" />
                        ) : layer.type === "image" ? (
                          <ImageIcon className="h-3.5 w-3.5 text-[#8b919c] shrink-0" />
                        ) : (
                          <Square className="h-3.5 w-3.5 text-[#8b919c] shrink-0" />
                        )}

                        <span
                          className={cn(
                            "text-xs truncate flex-1",
                            layer.dynamic && layer.name
                              ? "text-[#9fd0ff] font-mono"
                              : "text-[#c4c9d2]"
                          )}
                        >
                          {layer.name ||
                            `${layer.type} ${layers.length - idx}`}
                        </span>
                        {layer.mediaType === "video" && (
                          <span className="text-[10px] text-[#8b919c] font-mono shrink-0">
                            {Number(layer.videoDuration || 0).toFixed(1)}s
                          </span>
                        )}

                        <button
                          type="button"
                          draggable={false}
                          className={cn(
                            "shrink-0",
                            layer.locked
                              ? "text-[#e0a13a] opacity-100"
                              : "opacity-0 group-hover:opacity-100 text-[#8b919c] hover:text-[#e6e8ec]"
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            const canvas = fabricCanvasRef.current;
                            if (canvas) {
                              const locked = !layer.locked;
                              layer.object.set({
                                selectable: !locked,
                                evented: !locked,
                                hasControls: !locked,
                                hasBorders: !locked,
                                lockMovementX: locked,
                                lockMovementY: locked,
                              });
                              if (locked && activeObj === layer.object) {
                                canvas.discardActiveObject();
                                setSelectedObject(null);
                              }
                              canvas.renderAll();
                              updateLayers();
                            }
                          }}
                        >
                          {layer.locked ? (
                            <Lock className="h-3.5 w-3.5" />
                          ) : (
                            <Unlock className="h-3.5 w-3.5" />
                          )}
                        </button>

                        <button
                          type="button"
                          draggable={false}
                          className="opacity-0 group-hover:opacity-100 text-[#8b919c] hover:text-[#e6e8ec] shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            const canvas = fabricCanvasRef.current;
                            if (canvas) {
                              layer.object.set(
                                "visible",
                                !layer.visible
                              );
                              canvas.renderAll();
                              updateLayers();
                            }
                          }}
                        >
                          {layer.visible ? (
                            <Eye className="h-3.5 w-3.5" />
                          ) : (
                            <EyeOff className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>

        {/* ==================== STATUS BAR ==================== */}
        <div className="h-9 bg-[#14171c] border-t border-white/[0.08] flex items-center px-4 gap-3 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 text-[#8b919c] hover:text-[#e6e8ec]"
                onClick={() => setZoom(Math.max(MIN_ZOOM_PCT, zoom - 10))}
              >
                <Minus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom Out</TooltipContent>
          </Tooltip>

          <Slider
            value={[zoom]}
            onValueChange={([v]) => setZoom(v)}
            min={MIN_ZOOM_PCT}
            max={MAX_ZOOM_PCT}
            step={5}
            className="w-28"
          />

          <span className="text-[11px] text-[#8b919c] font-mono w-10">
            {Math.round(zoom)}%
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 text-[#8b919c] hover:text-[#e6e8ec]"
                onClick={() => setZoom(100)}
              >
                <Maximize2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fit to screen</TooltipContent>
          </Tooltip>

          <Separator
            orientation="vertical"
            className="h-4 bg-white/[0.08]"
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={undo}
                disabled={!canUndo}
                className="h-6 w-6 text-[#8b919c] hover:text-[#e6e8ec] disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo (⌘Z)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={redo}
                disabled={!canRedo}
                className="h-6 w-6 text-[#8b919c] hover:text-[#e6e8ec] disabled:opacity-40"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo (⌘⇧Z)</TooltipContent>
          </Tooltip>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-[#8b919c]" />
                <span className="text-[11px] text-[#8b919c]">Saving…</span>
              </>
            ) : saved ? (
              <>
                <div className="w-2 h-2 rounded-full bg-[#1d9e75] status-dot-active" />
                <span className="text-[11px] text-[#8b919c]">
                  All changes saved
                </span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 rounded-full bg-[#e0a13a]" />
                <span className="text-[11px] text-[#e0a13a]">
                  Unsaved changes
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>

      {/* ==================== EXPORT DIALOG ==================== */}
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
        canvasHasVideo={canvasHasVideo}
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
        onExport={doExport}
      />
    </>
  );
}
