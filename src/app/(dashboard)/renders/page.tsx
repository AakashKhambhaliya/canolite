"use client";
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import { useSearchParams } from "next/navigation";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { toast } from "sonner";
import {
  Search,
  Image as ImageIcon,
  RefreshCw,
  ExternalLink,
  Copy,
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Filter,
  Eye,
  FileImage,
  Trash2,
  Download,
  Package,
  Video,
} from "lucide-react";
import { cn, formatRelativeTime, formatDuration, copyToClipboard } from "@/lib/utils";
import { Suspense } from "react";

const STATUS_CONFIG: Record<string, { label: string; variant: any; icon: any }> = {
  queued: {
    label: "Queued",
    variant: "secondary",
    icon: Clock,
  },
  processing: {
    label: "Processing",
    variant: "info",
    icon: Loader2,
  },
  done: {
    label: "Completed",
    variant: "success",
    icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    icon: AlertCircle,
  },
};

function RendersContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const batchUid = searchParams.get("batch");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedRender, setSelectedRender] = useState<any>(null);

  const { data: renders, isLoading } = useQuery({
    queryKey: ["renders", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/renders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch renders");
      return res.json();
    },
    refetchInterval: 5000, // Poll for updates
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/renders/${id}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to retry");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renders"] });
      toast.success("Render retried");
    },
    onError: () => {
      toast.error("Failed to retry render");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/renders/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renders"] });
      toast.success("Render deleted");
    },
    onError: () => {
      toast.error("Failed to delete render");
    },
  });

  const confirmDelete = (id: string) => {
    if (window.confirm("Delete this render? This can't be undone.")) {
      deleteMutation.mutate(id);
    }
  };

  const filteredRenders = renders?.filter((r: any) =>
    r.uid?.toLowerCase().includes(search.toLowerCase()) ||
    r.templateName?.toLowerCase().includes(search.toLowerCase())
  );

  // Batch (CSV bulk) awareness for the ZIP download.
  const batchRenders = batchUid
    ? renders?.filter((r: any) => r.batchUid === batchUid)
    : null;
  const batchDone =
    batchRenders?.filter((r: any) => r.status === "done").length ?? 0;
  const batchTotal = batchRenders?.length ?? 0;
  const anyDone = renders?.some((r: any) => r.status === "done") ?? false;
  const canDownload = batchUid ? batchDone > 0 : anyDone;
  const downloadHref = batchUid
    ? `/api/renders/download?batch=${batchUid}`
    : `/api/renders/download`;

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Renders</h1>
          <p className="text-muted-foreground mt-1">
            Track and manage all render jobs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="accent"
            size="sm"
            disabled={!canDownload}
            onClick={() => {
              window.location.href = downloadHref;
            }}
            title={
              canDownload
                ? "Download completed renders as a ZIP"
                : "No completed renders to download yet"
            }
          >
            <Download className="mr-2 h-4 w-4" />
            Download ZIP
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ["renders"] })
            }
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Bulk batch banner (arriving from the CSV import flow) */}
      {batchUid && batchTotal > 0 && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex items-center gap-2 text-sm">
            <Package className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <span className="text-blue-800 dark:text-blue-300">
              Bulk batch — <strong>{batchDone}</strong> of{" "}
              <strong>{batchTotal}</strong> image{batchTotal === 1 ? "" : "s"}{" "}
              ready
              {batchDone < batchTotal ? " (still rendering…)" : ""}
            </span>
          </div>
          <Button
            variant="accent"
            size="sm"
            disabled={batchDone === 0}
            onClick={() => {
              window.location.href = downloadHref;
            }}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download {batchDone > 0 ? `${batchDone} ` : ""}as ZIP
          </Button>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search renders..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <Filter className="mr-2 h-4 w-4" />
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="done">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Renders list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="flex items-center gap-4 py-4">
                <Skeleton className="w-16 h-16 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !filteredRenders?.length ? (
        <EmptyState
          icon={ImageIcon}
          title={search || statusFilter !== "all" ? "No renders found" : "No renders yet"}
          description={
            search || statusFilter !== "all"
              ? "Try adjusting your filters"
              : "Renders will appear here when you generate images via the API or Playground."
          }
        />
      ) : (
        <div className="space-y-3">
          {filteredRenders.map((render: any) => {
            const status = STATUS_CONFIG[render.status] || STATUS_CONFIG.queued;
            const StatusIcon = status.icon;

            return (
              <Card
                key={render.id}
                className="hover:shadow-sm transition-shadow cursor-pointer"
                onClick={() => setSelectedRender(render)}
              >
                <CardContent className="flex items-center gap-4 py-4">
                  {/* Preview */}
                  <div className="w-14 h-14 rounded-lg bg-muted overflow-hidden flex items-center justify-center shrink-0">
                    {render.outputKind === "video" ? (
                      render.posterUrl ? (
                        <img src={render.posterUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Video className="h-6 w-6 text-muted-foreground" />
                      )
                    ) : render.imageUrl ? (
                      <img
                        src={render.imageUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <FileImage className="h-6 w-6 text-muted-foreground" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono font-medium">
                        {render.uid}
                      </code>
                      {render.batchUid && (
                        <Badge variant="outline" className="text-[10px]">
                          Batch
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <span>{render.format?.toUpperCase() || "PNG"}</span>
                      {render.outputKind === "video" && <Badge variant="outline" className="text-[10px]">Video</Badge>}
                      <span>·</span>
                      <span>{render.outputKind === "video" ? `${render.fps || 30} fps` : `Quality ${render.quality || 90}`}</span>
                      <span>·</span>
                      <span>Scale {render.scale || 1}x</span>
                      {render.durationMs && (
                        <>
                          <span>·</span>
                          <span>{formatDuration(render.durationMs)}</span>
                        </>
                      )}
                      <span>·</span>
                      <span>{formatRelativeTime(render.createdAt)}</span>
                    </div>
                  </div>

                  {render.status === "processing" && render.outputKind === "video" && (
                    <div className="w-28 shrink-0">
                      <div className="h-1.5 rounded bg-muted overflow-hidden">
                        <div className="h-full bg-blue-600" style={{ width: `${render.progress || 0}%` }} />
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1 text-right">{render.progress || 0}%</div>
                    </div>
                  )}

                  {/* Status */}
                  <Badge variant={status.variant} className="shrink-0 gap-1">
                    <StatusIcon
                      className={cn(
                        "h-3 w-3",
                        render.status === "processing" && "animate-spin"
                      )}
                    />
                    {status.label}
                  </Badge>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {render.imageUrl && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(render.imageUrl, "_blank");
                        }}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    )}
                    {render.status === "failed" && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          retryMutation.mutate(render.id);
                        }}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Delete render"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={
                        deleteMutation.isPending &&
                        deleteMutation.variables === render.id
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        confirmDelete(render.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Render detail dialog */}
      <Dialog
        open={!!selectedRender}
        onOpenChange={() => setSelectedRender(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono">
              {selectedRender?.uid}
            </DialogTitle>
          </DialogHeader>
          {selectedRender && (
            <div className="space-y-4">
              {/* Preview */}
              {selectedRender.imageUrl && (
                <div className="rounded-lg overflow-hidden bg-muted">
                  {selectedRender.outputKind === "video" ? (
                    <video
                      src={selectedRender.imageUrl}
                      poster={selectedRender.posterUrl || undefined}
                      controls
                      className="w-full object-contain max-h-80"
                    />
                  ) : (
                    <img
                      src={selectedRender.imageUrl}
                      alt=""
                      className="w-full object-contain max-h-80"
                    />
                  )}
                </div>
              )}

              {/* Details */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <div className="mt-1">
                    <Badge
                      variant={
                        STATUS_CONFIG[selectedRender.status]?.variant || "secondary"
                      }
                    >
                      {STATUS_CONFIG[selectedRender.status]?.label ||
                        selectedRender.status}
                    </Badge>
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Format</span>
                  <p className="mt-1 font-medium">
                    {selectedRender.format?.toUpperCase() || "PNG"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Quality</span>
                  <p className="mt-1 font-medium">
                    {selectedRender.quality || 90}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Duration</span>
                  <p className="mt-1 font-medium">
                    {selectedRender.durationMs
                      ? formatDuration(selectedRender.durationMs)
                      : "—"}
                  </p>
                </div>
              </div>

              {/* Error */}
              {selectedRender.errorMessage && (
                <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg">
                  <p className="text-sm text-red-700 dark:text-red-400 font-mono">
                    {selectedRender.errorMessage}
                  </p>
                </div>
              )}

              {/* Modifications */}
              {selectedRender.modifications && (
                <div>
                  <span className="text-sm text-muted-foreground">
                    Modifications
                  </span>
                  <pre className="mt-1 p-3 bg-muted rounded-lg text-xs overflow-auto max-h-40 font-mono">
                    {JSON.stringify(selectedRender.modifications, null, 2)}
                  </pre>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                {selectedRender.imageUrl && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        copyToClipboard(selectedRender.imageUrl);
                        toast.success("URL copied");
                      }}
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy URL
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        window.open(selectedRender.imageUrl, "_blank")
                      }
                    >
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                      Open
                    </Button>
                  </>
                )}
                {selectedRender.status === "failed" && (
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => {
                      retryMutation.mutate(selectedRender.id);
                      setSelectedRender(null);
                    }}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Retry
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto text-destructive hover:text-destructive"
                  onClick={() => {
                    const id = selectedRender.id;
                    if (
                      window.confirm("Delete this render? This can't be undone.")
                    ) {
                      deleteMutation.mutate(id);
                      setSelectedRender(null);
                    }
                  }}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function RendersPage() {
  return (
    <Suspense fallback={null}>
      <RendersContent />
    </Suspense>
  );
}
