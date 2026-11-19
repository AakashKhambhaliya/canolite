import { isImage } from "@/lib/design/predicates";
import { extractFields } from "@/lib/render/apply-modifications";

export function designHasVideo(value: any): boolean {
  const objects = Array.isArray(value?.objects) ? value.objects : [];
  const visit = (obj: any): boolean => {
    if (!obj || typeof obj !== "object") return false;
    // Must be case-insensitive (isImage lowercases): a LIVE Fabric object
    // reports type "image", but the SERIALIZED design stored here reports
    // "Image". Comparing to "image" directly never matched, so has_video
    // stayed false for every template — which is what hid MP4 from the export
    // options and made video renders fail with "does not contain video layers".
    if (isImage(obj) && obj.mediaType === "video") return true;
    return Array.isArray(obj.objects) && obj.objects.some(visit);
  };
  return objects.some(visit);
}

// Validate before entering a transaction; never partially replace the field list.
export function documentFields(design: unknown) {
  const inspect = (node: unknown, depth: number) => {
    if (depth > 64 || !node || typeof node !== "object" || Array.isArray(node))
      throw new Error("Invalid artwork layer.");
    const item = node as Record<string, unknown>;
    if (depth && (typeof item.type !== "string" || !item.type))
      throw new Error("Invalid artwork type.");
    if (item.objects !== undefined) {
      if (!Array.isArray(item.objects)) throw new Error("Invalid layer list.");
      for (const child of item.objects) inspect(child, depth + 1);
    }
    for (const key of ["clipPath", "backgroundImage", "overlayImage"])
      if (item[key] != null) inspect(item[key], depth + 1);
  };
  if (design != null) inspect(design, 0);
  const fields = extractFields(design);
  if (fields.some((f) => typeof f.name !== "string" || f.name.length > 255)) {
    throw new Error("API field names must be 255 characters or fewer.");
  }
  return fields;
}
