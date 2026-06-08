"use client";

import { useMemo, useState, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Check, ChevronsUpDown, Search, Upload, Loader2 } from "lucide-react";
import {
  GOOGLE_FONTS,
  SYSTEM_FONTS,
  ensureFont,
  registerCustomFont,
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
          className="flex h-8 w-full items-center justify-between rounded-md border border-white/[0.1] bg-[#1f232a] px-3 text-xs text-[#e6e8ec] hover:bg-[#23262c]"
        >
          <span className="truncate" style={{ fontFamily: value }}>
            {value || "Select font"}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0 bg-[#14171c] border-white/[0.1] text-[#e6e8ec]"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.08] px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-[#8b919c]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 1900+ fonts…"
            className="w-full bg-transparent text-xs text-[#e6e8ec] placeholder:text-[#6b7280] outline-none"
          />
        </div>

        <div className="max-h-64 overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-[#8b919c]">
              No fonts found
            </div>
          )}
          {results.map((f) => (
            <button
              key={`${f.group}-${f.family}`}
              type="button"
              onMouseEnter={() => ensureFont(f.family)}
              onClick={() => handleSelect(f.family)}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-[#23262c]"
            >
              <span className="truncate" style={{ fontFamily: f.family }}>
                {f.family}
              </span>
              <span className="flex items-center gap-1.5 shrink-0">
                {f.group === "Custom" && (
                  <span className="text-[9px] text-[#9fd0ff]">custom</span>
                )}
                {value === f.family && (
                  <Check className="h-3.5 w-3.5 text-[#1d9e75]" />
                )}
              </span>
            </button>
          ))}
        </div>

        <div className="border-t border-white/[0.08] p-1.5">
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-[#2f6fde] px-3 py-1.5 text-xs text-white hover:bg-[#2561c7] disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload custom font
          </button>
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
