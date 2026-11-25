// Alignment modes shared by the Properties panel (inspector.tsx), the toolbar's
// Align menu (chrome.tsx) and the canvas logic (editor-workspace.tsx). Kept in
// its own module so chrome.tsx and inspector.tsx don't import each other.
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
} from "lucide-react";

export type Alignment =
  | "left"
  | "centerH"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "distributeH"
  | "distributeV";
export type AlignTarget = "selection" | "artboard";

export const ALIGN_OPTIONS = [
  { id: "left", label: "Align left", i: AlignStartVertical },
  { id: "centerH", label: "Align center", i: AlignCenterVertical },
  { id: "right", label: "Align right", i: AlignEndVertical },
  { id: "top", label: "Align top", i: AlignStartHorizontal },
  { id: "middle", label: "Align middle", i: AlignCenterHorizontal },
  { id: "bottom", label: "Align bottom", i: AlignEndHorizontal },
] as const;

export const DISTRIBUTE_OPTIONS = [
  {
    id: "distributeH",
    label: "Distribute horizontally",
    i: AlignHorizontalDistributeCenter,
  },
  {
    id: "distributeV",
    label: "Distribute vertically",
    i: AlignVerticalDistributeCenter,
  },
] as const;
