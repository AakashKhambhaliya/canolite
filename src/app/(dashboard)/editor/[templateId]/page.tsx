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
} from "lucide-react";

// We'll store the fabric module reference once loaded
let fabricModule: any = null;

async function loadFabric() {
  if (fabricModule) return fabricModule;
  const mod = await import("fabric");
  fabricModule = mod.fabric || mod.default?.fabric || mod;
  return fabricModule;
}

// After a web font loads or a font changes, Fabric keeps a stale per-family
// glyph-metric cache and stale object caches, so text keeps rendering in the
// fallback font. Clear the font cache, re-measure every text object, and
// repaint (twice, to cover the next frame once glyphs are ready).
function refreshTextFonts(canvas: any) {
  if (!canvas) return;
  try {
    fabricModule?.util?.clearFabricFontCache?.();
  } catch {}
  for (const o of canvas.getObjects()) {
    if (/text|textbox|i-text/.test(o.type || "")) {
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
  // True once the canvas has been initialized for the current mount. Prevents
  // background refetches / cache updates from re-initializing (and wiping) the
  // live canvas. Reset on unmount so each (re)open initializes cleanly.
  const initializedRef = useRef(false);
  // Suppress "unsaved" marking while loadFromJSON fires object:added events.
  const loadingRef = useRef(false);

  const [selectedObject, setSelectedObject] = useState<any>(null);
  const [zoom, setZoom] = useState(70);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [templateName, setTemplateName] = useState("Untitled");
  const [layers, setLayers] = useState<any[]>([]);
  const [activeTool, setActiveTool] = useState<string>("select");
  const [canvasReady, setCanvasReady] = useState(false);
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  // Layer drag-and-drop reordering state.
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  // Force re-render helper
  const [, forceUpdate] = useState(0);
  const rerender = () => forceUpdate((n) => n + 1);

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
      // Apply the new stacking: bottom→top is the panel reversed.
      [...panel].reverse().forEach((l, i) => canvas.moveTo(l.object, i));
      canvas.renderAll();
      setSaved(false);
      updateLayers();
      rerender();
    },
    [layers, updateLayers]
  );

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

      const canvas = new fabric.Canvas(canvasRef.current, {
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

      // Load existing design
      if (template.designJson?.objects?.length > 0) {
        canvas.loadFromJSON(template.designJson, () => {
          if (disposed) return;
          canvas.renderAll();
          updateLayers();
          loadingRef.current = false;
          setSaved(true);
          setCanvasReady(true);
          // Load any non-system fonts used in the design, then repaint so the
          // text renders with the correct typeface.
          const families = new Set<string>();
          for (const o of canvas.getObjects()) {
            if (o.fontFamily) families.add(o.fontFamily);
          }
          families.forEach((f) =>
            ensureFont(f).then(() => !disposed && refreshTextFonts(canvas))
          );
        });
      } else {
        loadingRef.current = false;
        setCanvasReady(true);
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
        rerender();
      });
      canvas.on("object:added", () => {
        if (!loadingRef.current) setSaved(false);
        updateLayers();
      });
      canvas.on("object:removed", () => {
        if (!loadingRef.current) setSaved(false);
        updateLayers();
      });

      // Corner / center / edge snapping with alignment guides.
      cleanupSnap = installSnapping(canvas, fabric);
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
  }, [template, updateLayers]);

  // Save handler
  const handleSave = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    setSaving(true);

    const json = canvas.toJSON([
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
    });
  }, [templateName, template, saveMutation]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const canvas = fabricCanvasRef.current;
        const active = canvas?.getActiveObject();
        if (active) {
          canvas.remove(active);
          setSelectedObject(null);
          canvas.discardActiveObject();
          canvas.renderAll();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // Tool actions — all use the already-loaded fabric module
  const addText = useCallback(async () => {
    const fabric = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const text = new fabric.Textbox("Edit this text", {
      left: 100,
      top: 100,
      width: 300,
      fontSize: 32,
      fontFamily: "Arial",
      fill: "#000000",
      name: "",
      dynamic: true,
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    canvas.renderAll();
    setActiveTool("select");
  }, []);

  const addRect = useCallback(async () => {
    const fabric = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const rect = new fabric.Rect({
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
    const fabric = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const circle = new fabric.Circle({
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
    const fabric = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const triangle = new fabric.Triangle({
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
    const fabric = await loadFabric();
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const line = new fabric.Line([50, 100, 300, 100], {
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

      const fabric = await loadFabric();
      const reader = new FileReader();
      reader.onload = (ev) => {
        const url = ev.target?.result as string;
        fabric.Image.fromURL(url, (img: any) => {
          // Scale to fit ~50% of canvas
          const maxW = (template?.width || 1080) * 0.5;
          const maxH = (template?.height || 1350) * 0.5;
          const scale = Math.min(maxW / img.width, maxH / img.height, 1);
          img.set({
            left: 50,
            top: 50,
            scaleX: scale,
            scaleY: scale,
            name: "",
            dynamic: true,
          });
          canvas.add(img);
          canvas.setActiveObject(img);
          canvas.renderAll();
        });
      };
      reader.readAsDataURL(file);
    };
    input.click();
    setActiveTool("select");
  }, [template]);

  const handleExport = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const dataURL = canvas.toDataURL({
      format: "png",
      quality: 1,
      multiplier: 2,
    });
    const link = document.createElement("a");
    link.download = `${templateName || "template"}.png`;
    link.href = dataURL;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [templateName]);

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
  const objType = activeObj?.type;
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
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col h-screen bg-[#0f1115] text-[#e6e8ec] overflow-hidden">
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
                className="text-[#c4c9d2] hover:text-[#e6e8ec] hover:bg-[#23262c] text-xs"
              >
                File
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-[#14171c] border-white/[0.1] text-[#e6e8ec]">
              <DropdownMenuItem
                className="text-xs focus:bg-[#23262c]"
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
                onClick={handleSave}
              >
                <Save className="mr-2 h-3.5 w-3.5" />
                Save
                <span className="ml-auto text-[#8b919c] text-[10px]">
                  ⌘S
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs focus:bg-[#23262c]"
                onClick={handleExport}
              >
                <Download className="mr-2 h-3.5 w-3.5" />
                Export PNG
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
            <span className="text-[10px] text-[#8b919c] font-mono">
              {template?.width}×{template?.height}
            </span>
          </div>

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className="text-[#e0a13a] hover:bg-[#23262c] text-xs gap-1.5"
            onClick={() =>
              router.push(
                `/playground?template=${template?.templateId}`
              )
            }
          >
            <Zap className="h-3.5 w-3.5" />
            Automate
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleExport}
                className="text-[#c4c9d2] hover:text-[#e6e8ec] hover:bg-[#23262c]"
              >
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export PNG</TooltipContent>
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
          <div className="flex-1 overflow-auto flex items-center justify-center bg-[#0f1115] relative">
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundImage:
                  "radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px)",
                backgroundSize: "24px 24px",
              }}
            />
            <div
              className="relative shadow-2xl"
              style={{
                transform: `scale(${zoom / 100})`,
                transformOrigin: "center center",
              }}
            >
              <canvas ref={canvasRef} />
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
                          checked={getProp("dynamic", true)}
                          onCheckedChange={(v) =>
                            updateProp("dynamic", v)
                          }
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
                              Line Height
                            </Label>
                            <Input
                              type="number"
                              value={getProp("lineHeight", 1.2)}
                              onChange={(e) =>
                                updateProp(
                                  "lineHeight",
                                  parseFloat(e.target.value)
                                )
                              }
                              step={0.1}
                              min={0.5}
                              max={5}
                              className="h-8 text-xs bg-[#1f232a] border-white/[0.1] text-[#e6e8ec]"
                            />
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
                            className="w-full text-xs text-[#c4c9d2] hover:bg-[#23262c]"
                            onClick={addImage}
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
                        className="w-full text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
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
                onClick={() => setZoom(Math.max(20, zoom - 10))}
              >
                <Minus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom Out</TooltipContent>
          </Tooltip>

          <Slider
            value={[zoom]}
            onValueChange={([v]) => setZoom(v)}
            min={20}
            max={200}
            step={5}
            className="w-28"
          />

          <span className="text-[11px] text-[#8b919c] font-mono w-10">
            {zoom}%
          </span>

          <Separator
            orientation="vertical"
            className="h-4 bg-white/[0.08]"
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 text-[#8b919c] hover:text-[#e6e8ec]"
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
                className="h-6 w-6 text-[#8b919c] hover:text-[#e6e8ec]"
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
  );
}
