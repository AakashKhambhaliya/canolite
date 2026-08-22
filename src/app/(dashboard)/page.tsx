"use client";
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { toast } from "sonner";
import {
  Plus,
  Search,
  MoreHorizontal,
  Copy,
  Trash2,
  Pencil,
  ExternalLink,
  LayoutGrid,
  Loader2,
  FileImage,
  Video,
} from "lucide-react";
import { cn, formatRelativeTime, copyToClipboard } from "@/lib/utils";
import { Label } from "@/components/ui/label";

const CANVAS_PRESETS = [
  { name: "Instagram Post", width: 1080, height: 1080 },
  { name: "Instagram Story", width: 1080, height: 1920 },
  { name: "Facebook Post", width: 1200, height: 630 },
  { name: "Twitter Post", width: 1600, height: 900 },
  { name: "YouTube Thumbnail", width: 1280, height: 720 },
  { name: "LinkedIn Post", width: 1200, height: 627 },
  { name: "Poster (A4)", width: 2480, height: 3508 },
  { name: "Business Card", width: 1050, height: 600 },
  { name: "Custom", width: 1080, height: 1350 },
];

// Bounds for the Custom preset's width/height inputs. Kept below the server's
// hard cap (MAX_CANVAS_DIMENSION in lib/validation) — this is the practical
// design limit, that one is the "never let this reach the renderer" limit.
const MIN_CUSTOM_DIMENSION = 100;
const MAX_CUSTOM_DIMENSION = 10000;

export default function TemplatesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState(CANVAS_PRESETS[0]);
  const [customWidth, setCustomWidth] = useState(1080);
  const [customHeight, setCustomHeight] = useState(1350);
  const [newName, setNewName] = useState("Untitled Template");
  const [isCreating, setIsCreating] = useState(false);

  const { data: templates, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: async () => {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error("Failed to fetch templates");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      // The min/max on the number Inputs below are advisory — the browser
      // still hands us whatever was typed, and a cleared field reads back as
      // 0. Clamp here so a slip becomes a usable template instead of a 400
      // from the server-side dimension check.
      const clamp = (value: number, fallback: number) =>
        Number.isFinite(value) && value > 0
          ? Math.min(MAX_CUSTOM_DIMENSION, Math.max(MIN_CUSTOM_DIMENSION, Math.round(value)))
          : fallback;
      const width =
        selectedPreset.name === "Custom"
          ? clamp(customWidth, 1080)
          : selectedPreset.width;
      const height =
        selectedPreset.name === "Custom"
          ? clamp(customHeight, 1350)
          : selectedPreset.height;

      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() || "Untitled Template", width, height }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create template");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      setCreateOpen(false);
      toast.success("Template created");
      router.push(`/editor/${data.id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create template");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete template");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      setDeleteConfirm(null);
      toast.success("Template deleted");
    },
    onError: () => {
      toast.error("Failed to delete template");
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/templates/${id}/duplicate`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to duplicate template");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template duplicated");
    },
    onError: () => {
      toast.error("Failed to duplicate template");
    },
  });

  const filteredTemplates = templates?.filter((t: any) =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Templates</h1>
          <p className="text-muted-foreground mt-1">
            Design templates and generate images via API
          </p>
        </div>
        <Button
          variant="accent"
          onClick={() => setCreateOpen(true)}
          className="shrink-0"
        >
          <Plus className="mr-2 h-4 w-4" />
          New Template
        </Button>
      </div>

      {/* Search & filter */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Templates grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <Skeleton className="aspect-[4/3]" />
              <div className="p-4 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </Card>
          ))}
        </div>
      ) : !filteredTemplates?.length ? (
        <EmptyState
          icon={LayoutGrid}
          title={search ? "No templates found" : "Create your first template"}
          description={
            search
              ? "Try a different search term"
              : "Design a template in the visual editor, then generate images via API or CSV upload."
          }
          action={
            !search ? (
              <Button variant="accent" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New Template
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filteredTemplates.map((template: any) => (
            <Card
              key={template.id}
              className="overflow-hidden group hover:shadow-md transition-shadow cursor-pointer border-gray-200 dark:border-gray-800"
              onClick={() => router.push(`/editor/${template.id}`)}
            >
              {/* Thumbnail */}
              <div className="aspect-[4/3] bg-gradient-to-br from-gray-100 to-gray-50 dark:from-gray-800 dark:to-gray-900 relative overflow-hidden flex items-center justify-center">
                {template.thumbnailUrl ? (
                  <img
                    src={template.thumbnailUrl}
                    alt={template.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <FileImage className="h-12 w-12 text-gray-300 dark:text-gray-600" />
                )}
                {template.hasVideo && (
                  <Badge className="absolute left-2 top-2 gap-1 bg-black/70 text-white border-0">
                    <Video className="h-3 w-3" />
                    Video
                  </Badge>
                )}
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button size="sm" variant="secondary" className="shadow-lg">
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Open Editor
                    </Button>
                  </div>
                </div>
              </div>

              {/* Info */}
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-sm truncate">
                      {template.name}
                    </h3>
                    <div className="flex items-center gap-2 mt-1.5">
                      <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0">
                        {template.templateId}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {template.width}×{template.height} ·{" "}
                      {formatRelativeTime(template.updatedAt)}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      asChild
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem
                        onClick={() => router.push(`/editor/${template.id}`)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Open Editor
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          copyToClipboard(template.templateId);
                          toast.success("Template ID copied");
                        }}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        Copy ID
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => duplicateMutation.mutate(template.id)}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(`/playground?template=${template.templateId}`)
                        }
                      >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open in Playground
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteConfirm(template.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create template dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Template</DialogTitle>
            <DialogDescription>
              Choose a canvas size to get started
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Template name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Template"
              />
            </div>
            <div className="space-y-2">
              <Label>Canvas size</Label>
              <Select
                value={selectedPreset.name}
                onValueChange={(val) =>
                  setSelectedPreset(
                    CANVAS_PRESETS.find((p) => p.name === val) || CANVAS_PRESETS[0]
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CANVAS_PRESETS.map((preset) => (
                    <SelectItem key={preset.name} value={preset.name}>
                      {preset.name}{" "}
                      {preset.name !== "Custom" &&
                        `(${preset.width}×${preset.height})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedPreset.name === "Custom" && (
              <div className="flex gap-3">
                <div className="flex-1 space-y-2">
                  <Label>Width (px)</Label>
                  <Input
                    type="number"
                    value={customWidth}
                    onChange={(e) => setCustomWidth(Number(e.target.value))}
                    min={MIN_CUSTOM_DIMENSION}
                    max={MAX_CUSTOM_DIMENSION}
                  />
                </div>
                <div className="flex-1 space-y-2">
                  <Label>Height (px)</Label>
                  <Input
                    type="number"
                    value={customHeight}
                    onChange={(e) => setCustomHeight(Number(e.target.value))}
                    min={MIN_CUSTOM_DIMENSION}
                    max={MAX_CUSTOM_DIMENSION}
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create Template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Template</DialogTitle>
            <DialogDescription>
              This action cannot be undone. All renders using this template will
              still be available, but no new renders can be created.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
