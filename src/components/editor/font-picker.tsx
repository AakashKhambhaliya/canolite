"use client";

import { useMemo, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Check, ChevronsUpDown, Search, Upload, Loader2 } from "lucide-react";
import {
  GOOGLE_FONTS,
  SYSTEM_FONTS,
  ensureFont,
} from "@/lib/editor/font-loader";

export interface CustomFont {
  family: string;
  url: string;
}

interface FontPickerProps {
  value: string;
  onChange: (family: string) => void;
  customFonts: CustomFont[];
  onUpload: (file: File) => Promise<void>;
}

const MAX_RESULTS = 60;

export function FontPicker({
  value,
  onChange,
  customFonts,
  onUpload,
}: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const custom = customFonts.map((f) => ({
      family: f.family,
      group: "Custom",
    }));
    const system = SYSTEM_FONTS.map((f) => ({ family: f, group: "System" }));
    const google = GOOGLE_FONTS.map((f) => ({
      family: f.family,
      group: "Google",
    }));
    const all = [...custom, ...system, ...google];
    const filtered = q
      ? all.filter((f) => f.family.toLowerCase().includes(q))
      : all;
    return filtered.slice(0, MAX_RESULTS);
  }, [query, customFonts]);

  async function handleSelect(family: string) {
    await ensureFont(family);
    onChange(family);
    setOpen(false);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      await onUpload(file);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose typeface"
          className="sl-font-trigger"
        >
          <span className="truncate" style={{ fontFamily: value }}>
            {value || "Select font"}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="sl-font-pop w-64 p-0">
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 1900+ fonts…"
            className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
          />
        </div>

        <div className="max-h-64 overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No fonts found
            </div>
          )}
          {results.map((f) => (
            <button
              key={`${f.group}-${f.family}`}
              type="button"
              onMouseEnter={() => ensureFont(f.family)}
              onClick={() => handleSelect(f.family)}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            >
              <span className="truncate" style={{ fontFamily: f.family }}>
                {f.family}
              </span>
              <span className="flex items-center gap-1.5 shrink-0">
                {f.group === "Custom" && (
                  <span className="text-[9px] text-blue-700 dark:text-blue-400">
                    custom
                  </span>
                )}
                {value === f.family && (
                  <Check className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                )}
              </span>
            </button>
          ))}
        </div>

        <div className="border-t border-border p-1.5">
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="w-full gap-2 text-xs"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload custom font
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
            className="hidden"
            onChange={handleFile}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
