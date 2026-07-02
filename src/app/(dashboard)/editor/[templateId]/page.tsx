"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn, copyToClipboard } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { installSnapping } from "@/lib/editor/snapping";
import { ensureFont, registerCustomFont } from "@/lib/editor/font-loader";
import { FontPicker, type CustomFont } from "@/components/editor/font-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Minus as LineIcon,
  MousePointer,
  SlidersHorizontal,
  Lock,
  Unlock,
  Maximize2,
} from "lucide-react";

// We'll store the fabric module reference once loaded
let fabricModule: typeof import("fabric") | null = null;

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

export default function EditorPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const templateId = params.templateId as string;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<any>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // True once the canvas has been initialized for the current mount. Prevents
  // background refetches / cache updates from re-initializing (and wiping) the
  // live canvas. Reset on unmount so each (re)open initializes cleanly.
  const initializedRef = useRef(false);
  // Suppress "unsaved" marking while loadFromJSON fires object:added events.
  const loadingRef = useRef(false);

  const [selectedObject, setSelectedObject] = useState<any>(null);
  const [zoom, setZoom] = useState(70);
  // Lowest zoom the user can reach. Computed relative to the canvas size vs the
  // workspace viewport so a large template can always be zoomed out far enough
  // to fit on screen (a fixed floor stranded big canvases — they couldn't shrink
  // enough to be fully visible). Capped at 20 so small canvases keep the old feel.
  const [minZoom, setMinZoom] = useState(20);
  // Tracks which template id has already been auto-fitted, so we only shrink an
  // oversized canvas to fit on first open — never fighting the user afterwards.
  const fittedTemplateRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [templateName, setTemplateName] = useState("Untitled");
  const [layers, setLayers] = useState<any[]>([]);
  const [activeTool, setActiveTool] = useState<string>("select");
  const [canvasReady, setCanvasReady] = useState(false);
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  // Per-template output defaults
  const [outputFormat, setOutputFormat] = useState<string>("");
  const [outputQuality, setOutputQuality] = useState<number | "">("" );
  const [outputScale, setOutputScale] = useState<number | "">("" );
  // Layer drag-and-drop reordering state.
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  // Force re-render helper
  const [, forceUpdate] = useState(0);
  const rerender = () => forceUpdate((n) => n + 1);

  // ---- Undo / redo history -------------------------------------------------
  // Fabric v6 has no built-in history, so we keep a bounded stack of canvas
  // JSON snapshots. Pushed on every add/modify/remove; restored on undo/redo.
  const HISTORY_LIMIT = 80;
  const HISTORY_PROPS = ["name", "dynamic", "id", "selectable", "evented"];
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
    [layers, updateLayers]
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
    [updateLayers]
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

  // Initialize Fabric canvas — once per mount, from the loaded template.
  useEffect(() => {
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
      // Load per-template output defaults
      const od = template.outputDefaults as any;
      if (od) {
        setOutputFormat(od.format || "");
        setOutputQuality(od.quality ?? "");
        setOutputScale(od.scale ?? "");
      }

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
      canvas.on("object:removed", () => {
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
  }, [template?.id, updateLayers]);

  // Apply zoom via Fabric's native viewport (NOT a CSS transform). CSS-scaling
  // the canvas wrapper breaks in-canvas text editing (mis-positioned textarea /
  // caret) and shrinks the selection control handles along with everything else.
  // Native zoom keeps the design's logical coordinates intact while resizing the
  // on-screen canvas, so editing and the handles stay correct at any zoom.
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canvasReady) return;
    const z = zoom / 100;
    const w = template?.width || 1080;
    const h = template?.height || 1350;
    canvas.setZoom(z);
    canvas.setDimensions({ width: w * z, height: h * z });
    canvas.requestRenderAll();
  }, [zoom, canvasReady, template?.width, template?.height]);

  // The zoom % that makes the whole template fit inside the workspace viewport
  // (accounting for the p-16 = 64px padding on each side). Rounded down to the
  // slider's 5% step, with a hard 5% floor for sanity on huge canvases.
  const computeFitZoom = useCallback(() => {
    const ws = workspaceRef.current;
    const w = template?.width || 1080;
    const h = template?.height || 1350;
    const availW = (ws?.clientWidth || 800) - 128;
    const availH = (ws?.clientHeight || 600) - 128;
    const fit = Math.min(availW / w, availH / h) * 100;
    return Math.max(5, Math.floor(fit / 5) * 5);
  }, [template?.width, template?.height]);

  // Keep the zoom floor relative to the canvas/viewport, and re-derive it when
  // the workspace resizes (window resize, sidebar toggles, etc.). Clamp the
  // current zoom up if it ends up below the new floor.
  useEffect(() => {
    if (!canvasReady) return;
    const recompute = () => {
      const floor = Math.max(5, Math.min(20, computeFitZoom()));
      setMinZoom(floor);
      setZoom((z) => (z < floor ? floor : z));
    };
    recompute();
    const ws = workspaceRef.current;
    if (!ws || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(ws);
    return () => ro.disconnect();
  }, [canvasReady, computeFitZoom]);

  // On first open of a template, fit a *genuinely oversized* canvas — one that
  // can't be made to fit within the old fixed 20% floor. Normal templates keep
  // their default zoom so this doesn't change everyday behavior.
  useEffect(() => {
    if (!canvasReady || !template?.id) return;
    if (fittedTemplateRef.current === template.id) return;
    fittedTemplateRef.current = template.id;
    const fit = computeFitZoom();
    if (fit < 20) setZoom(fit);
  }, [canvasReady, template?.id, computeFitZoom]);

  // Save handler
  const handleSave = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
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

    const json = canvas.toObject([
      "name",
      "dynamic",
      "id",
      "selectable",
      "evented",
    ]);

    saveMutation.mutate({
      name: templateName,
      designJson: json,
      width: template?.width,
      height: template?.height,
      outputDefaults: {
        format: outputFormat || undefined,
        quality: outputQuality !== "" ? Number(outputQuality) : undefined,
        scale: outputScale !== "" ? Number(outputScale) : undefined,
      },
    });
  }, [templateName, template, saveMutation, outputFormat, outputQuality, outputScale]);

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

  // Export dialog state
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<string>("png");
  const [exportQuality, setExportQuality] = useState(100);
  const [exportScale, setExportScale] = useState(2);

  const doExport = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    // The editor zooms via Fabric's viewport, so temporarily reset to 1:1 at
    // full template dimensions before exporting, then restore the editor zoom.
    // Otherwise the export would come out at the on-screen (zoomed) size.
    const w = template?.width || 1080;
    const h = template?.height || 1350;
    const z = zoom / 100;
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
        const dataURL = canvas.toDataURL({
          format: exportFormat as any,
          quality: exportQuality / 100,
          multiplier: exportScale,
        });
        const link = document.createElement("a");
        link.download = `${templateName || "template"}.${exportFormat === "jpeg" ? "jpg" : exportFormat}`;
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
  }, [templateName, exportFormat, exportQuality, exportScale, zoom, template?.width, template?.height]);

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
    [updateLayers]
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
    [updateLayers]
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
  const isImage = objType === "image";
  const isShape =
    objType === "rect" ||
    objType === "circle" ||
    objType === "triangle" ||
    objType === "ellipse" ||
    objType === "polygon" ||
    objType === "line";

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
              className="w-72 p-4 border-white/10"
              style={{
                backgroundColor: "#14171c",
                color: "#e6e8ec",
              }}
            >
              <h4 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "#c4c9d2" }}>
                Output Settings
              </h4>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                    Format
                  </Label>
                  <Select
                    value={outputFormat || "__default__"}
                    onValueChange={(v) => {
                      setOutputFormat(v === "__default__" ? "" : v);
                      setSaved(false);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[#14171c] border-white/[0.1] text-[#e6e8ec]">
                      <SelectItem value="__default__">Use global default</SelectItem>
                      <SelectItem value="png">PNG</SelectItem>
                      <SelectItem value="jpg">JPG</SelectItem>
                      <SelectItem value="webp">WebP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                      Quality
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={outputQuality}
                      onChange={(e) => {
                        setOutputQuality(e.target.value ? Number(e.target.value) : "");
                        setSaved(false);
                      }}
                      placeholder="Default"
                      className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                      Scale
                    </Label>
                    <Select
                      value={outputScale !== "" ? String(outputScale) : "__default__"}
                      onValueChange={(v) => {
                        setOutputScale(v === "__default__" ? "" : Number(v));
                        setSaved(false);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[#14171c] border-white/[0.1] text-[#e6e8ec]">
                        <SelectItem value="__default__">Default</SelectItem>
                        <SelectItem value="1">1x</SelectItem>
                        <SelectItem value="2">2x</SelectItem>
                        <SelectItem value="3">3x</SelectItem>
                        <SelectItem value="4">4x</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {(() => {
                  const w = template?.width || 1080;
                  const h = template?.height || 1350;
                  const s = outputScale !== "" ? Number(outputScale) : 1;
                  const q = outputQuality !== "" ? Number(outputQuality) : 90;
                  const fmt = outputFormat || "png";
                  const pixels = w * s * h * s;

                  // Calculate complexity from layers
                  let complexityScore = 1;
                  if (template?.designJson?.objects) {
                    template.designJson.objects.forEach((obj: any) => {
                      if (obj.type === 'image') complexityScore += 1.5;
                      else if (obj.type === 'i-text' || obj.type === 'textbox') complexityScore += 0.2;
                      else complexityScore += 0.1;
                    });
                  }
                  const multiplier = Math.min(Math.max(complexityScore, 1), 6);
                  
                  // Adjusted for highly compressible graphic templates (solid colors/text):
                  const baseBytesPerPx =
                    fmt === "png" 
                      ? 0.05 
                      : fmt === "webp" 
                        ? 0.005 + (q / 100) * 0.01 
                        : 0.002 + (q / 100) * 0.015;
                        
                  const sizeBytes = Math.round(pixels * baseBytesPerPx * multiplier);
                  const sizeStr =
                    sizeBytes > 1024 * 1024
                      ? `~${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                      : `~${Math.round(sizeBytes / 1024)} KB`;
                  return (
                    <p className="text-[10px] pt-1" style={{ color: "#8b919c" }}>
                      Est. size: {sizeStr}
                    </p>
                  );
                })()}
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
          <div ref={workspaceRef} className="flex-1 overflow-auto bg-[#0f1115] relative">
            <div
              className="absolute inset-0 opacity-20 pointer-events-none"
              style={{
                backgroundImage:
                  "radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px)",
                backgroundSize: "24px 24px",
              }}
            />
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
                      {objType}
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
                onClick={() => setZoom(Math.max(minZoom, zoom - 10))}
              >
                <Minus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom Out</TooltipContent>
          </Tooltip>

          <Slider
            value={[zoom]}
            onValueChange={([v]) => setZoom(v)}
            min={minZoom}
            max={200}
            step={5}
            className="w-28"
          />

          <span className="text-[11px] text-[#8b919c] font-mono w-10">
            {zoom}%
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 text-[#8b919c] hover:text-[#e6e8ec]"
                onClick={() => setZoom(computeFitZoom())}
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
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
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
                {(["png", "jpeg", "webp", "svg"] as const).map((fmt) => (
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

            {/* Quality (only for JPEG/WebP) */}
            {(exportFormat === "jpeg" || exportFormat === "webp") && (
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

            {/* Scale (not for SVG) */}
            {exportFormat !== "svg" && (
              <div className="space-y-1.5">
                <Label className="text-[11px]" style={{ color: "#c4c9d2" }}>
                  Scale
                </Label>
                <div className="grid grid-cols-4 gap-2">
                  {[1, 2, 3, 4].map((s) => (
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
                  Output: {(template?.width || 1080) * exportScale} × {(template?.height || 1350) * exportScale}px
                </p>
              </div>
            )}

            {/* Export button */}
            <Button
              onClick={doExport}
              className="w-full bg-[#2f6fde] hover:bg-[#2561c7] text-white"
            >
              <Download className="mr-2 h-4 w-4" />
              Export {exportFormat.toUpperCase()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
