import type { DesignObject, ImageDesignObject, ShapeDesignObject, TextDesignObject } from "./types";

export function objectType(obj: DesignObject | null | undefined): string {
  return (obj?.type || "").toLowerCase();
}

export function isText(obj: DesignObject | null | undefined): obj is TextDesignObject {
  const t = objectType(obj);
  return t === "textbox" || t === "text" || t === "i-text";
}

export function isImage(obj: DesignObject | null | undefined): obj is ImageDesignObject {
  return objectType(obj) === "image";
}

export function isShape(obj: DesignObject | null | undefined): obj is ShapeDesignObject {
  const t = objectType(obj);
  return t === "rect" || t === "circle" || t === "triangle" || t === "ellipse" || t === "polygon" || t === "line";
}
