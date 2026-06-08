"use client";

import { Suspense } from "react";
import { PlaygroundContent } from "./playground-content";
import { Loader2 } from "lucide-react";

export default function PlaygroundPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <PlaygroundContent />
    </Suspense>
  );
}
