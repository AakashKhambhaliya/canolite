/**
 * Apply modifications to a Fabric design JSON.
 * This is a PURE function — shared by the API validation layer,
 * the Chromium render page, and the optional node-canvas path.
 *
 * Rules:
 * - Unknown `name` → warn + ignore (don't fail the render)
 * - Missing field → keep template default
 * - `text` → set string on text object
 * - `image_url` → swap `src` and re-fit to the layer's existing box
 * - Style overrides validated against allowlist
 */
import { walkDesignObjects } from "@/lib/design/walk";
import { isImage, isText, objectType } from "@/lib/design/predicates";

export interface Modification {
  name: string;
  text?: string;
  image_url?: string;
  video_url?: string;
  trim_start?: number;
  trim_end?: number;
  start_at?: number;
  volume?: number;
  muted?: boolean;
  loop?: boolean;
  // Style overrides (text)
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  fill?: string;
  textAlign?: string;
  lineHeight?: number;
  height?: number;
  charSpacing?: number;
  underline?: boolean;
  opacity?: number;
  // Style overrides (image)
  // opacity is shared
  backgroundColor?: string;
}

export interface ApplyResult {
  modifiedJson: any;
  warnings: string[];
}

// Allowlist per layer type
const TEXT_ALLOWLIST = new Set([
  "text",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fill",
  "textAlign",
  "lineHeight",
  "height",
  "charSpacing",
  "underline",
  "opacity",
  "backgroundColor",
]);

const IMAGE_ALLOWLIST = new Set(["image_url", "opacity"]);
const VIDEO_ALLOWLIST = new Set([
  "video_url",
  "opacity",
  "trim_start",
  "trim_end",
  "start_at",
  "volume",
  "muted",
  "loop",
]);

const VIDEO_PROP_MAP: Record<string, string> = {
  video_url: "videoSrc",
  trim_start: "trimStart",
  trim_end: "trimEnd",
  start_at: "startAt",
};

const BLOCKED_FIELDS = new Set([
  "left",
  "top",
  "angle",
  "scaleX",
  "scaleY",
  "originX",
  "originY",
  "width",
]);

// Available bundled fonts
const BUNDLED_FONTS = new Set([
  "Inter",
  "Archivo",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Raleway",
  "Oswald",
  "Playfair Display",
  "Source Sans Pro",
  "Nunito",
  "Ubuntu",
  "Merriweather",
  "PT Sans",
  "Noto Sans",
  "Rubik",
  "Work Sans",
  "Quicksand",
  "Barlow",
  "DM Sans",
  "Fira Sans",
  "Mulish",
  "Karla",
  "Josefin Sans",
  "Libre Baskerville",
  "Bitter",
  "IBM Plex Sans",
  "Cabin",
  "Arimo",
]);

export function applyModifications(
  designJson: any,
  modifications: Modification[],
  availableFonts?: Set<string>
): ApplyResult {
  const warnings: string[] = [];
  const fonts = availableFonts || BUNDLED_FONTS;

  // Deep clone to avoid mutation. A template can have designJson: null (no
  // NOT NULL constraint on the column, and the templates PUT route accepts
  // it as-is) — JSON.parse(JSON.stringify(null)) is null, and `null.objects`
  // below would throw before the `|| []` fallback ever applies, so fall back
  // to an empty design up front instead.
  const json = JSON.parse(JSON.stringify(designJson)) || { objects: [] };

  if (!modifications || modifications.length === 0) {
    return { modifiedJson: json, warnings };
  }

  // Build a map of named objects from the design
  const namedObjects = new Map<string, any>();
  walkDesignObjects(json, ({ object: obj }) => {
    if (obj.name) {
      namedObjects.set(obj.name, obj);
    }
  });

  for (const mod of modifications) {
    if (!mod.name) {
      warnings.push("Modification missing 'name' field — skipped");
      continue;
    }

    const obj = namedObjects.get(mod.name);
    if (!obj) {
      warnings.push(
        `Unknown field name "${mod.name}" — no matching layer found, skipped`
      );
      continue;
    }

    // Check for blocked fields
    for (const key of Object.keys(mod)) {
      if (key === "name") continue;
      if (BLOCKED_FIELDS.has(key)) {
        warnings.push(
          `Field "${key}" on "${mod.name}" is position-locked and cannot be overridden — ignored`
        );
      }
    }

    const objType = objectType(obj);
    const isTextLayer = isText(obj);
    const isVideoLayer = isImage(obj) && obj.mediaType === "video";
    const isImageLayer = isImage(obj) && !isVideoLayer;

    if (isTextLayer) {
      // Apply text content
      if (mod.text !== undefined) {
        obj.text = mod.text;
      }

      // Apply allowed style overrides
      for (const [key, value] of Object.entries(mod)) {
        if (key === "name" || key === "text") continue;
        if (BLOCKED_FIELDS.has(key)) continue;

        if (!TEXT_ALLOWLIST.has(key)) {
          warnings.push(
            `Property "${key}" not in text allowlist for "${mod.name}" — ignored`
          );
          continue;
        }

        // Validate font family
        if (key === "fontFamily" && typeof value === "string") {
          if (!fonts.has(value)) {
            warnings.push(
              `Font "${value}" not available for "${mod.name}" — keeping template font "${obj.fontFamily}"`
            );
            continue;
          }
        }

        obj[key] = value;
      }
    } else if (isVideoLayer) {
      for (const [key, value] of Object.entries(mod)) {
        if (key === "name") continue;
        if (BLOCKED_FIELDS.has(key)) continue;

        if (!VIDEO_ALLOWLIST.has(key)) {
          warnings.push(
            `Property "${key}" not in video allowlist for "${mod.name}" — ignored`
          );
          continue;
        }

        const targetKey = VIDEO_PROP_MAP[key] || key;
        if (targetKey === "videoSrc" && typeof value === "string") {
          obj.videoSrc = value;
          continue;
        }
        if (targetKey === "trimEnd" && typeof value === "number") {
          const duration = Number(obj.videoDuration || 0);
          obj.trimEnd = duration > 0 ? Math.min(value, duration) : value;
          if (duration > 0 && value > duration) {
            warnings.push(
              `trim_end for "${mod.name}" exceeds video duration and was clamped`
            );
          }
          continue;
        }
        obj[targetKey] = value;
      }
    } else if (isImageLayer) {
      // Apply image URL swap
      if (mod.image_url) {
        obj.src = mod.image_url;
        // Preserve existing fit/crop settings — the image will re-fit
        // to the same bounding box when rendered
      }

      // Apply allowed image overrides
      for (const [key, value] of Object.entries(mod)) {
        if (key === "name" || key === "image_url") continue;
        if (BLOCKED_FIELDS.has(key)) continue;

        if (!IMAGE_ALLOWLIST.has(key)) {
          warnings.push(
            `Property "${key}" not in image allowlist for "${mod.name}" — ignored`
          );
          continue;
        }

        obj[key] = value;
      }
    } else {
      // Shape/other layers — limited overrides
      if (mod.fill) obj.fill = mod.fill;
      if (mod.opacity !== undefined) obj.opacity = mod.opacity;
      if (mod.backgroundColor) obj.backgroundColor = mod.backgroundColor;

      for (const [key, value] of Object.entries(mod)) {
        if (
          key === "name" ||
          key === "fill" ||
          key === "opacity" ||
          key === "backgroundColor"
        )
          continue;
        if (key !== "name") {
          warnings.push(
            `Property "${key}" not supported for layer type "${obj.type}" on "${mod.name}" — ignored`
          );
        }
      }
    }
  }

  return { modifiedJson: json, warnings };
}

/**
 * Extract dynamic fields from a design JSON
 */
export function extractFields(
  designJson: any
): Array<{
  name: string;
  type: string;
  defaultValue: string;
  properties: Record<string, any>;
}> {
  const fields: Array<{
    name: string;
    type: string;
    defaultValue: string;
    properties: Record<string, any>;
  }> = [];

  walkDesignObjects(designJson, ({ object: obj }) => {
    if (obj.name && obj.dynamic !== false) {
      const video = isImage(obj) && obj.mediaType === "video";
      const image = isImage(obj) && !video;
      const text = isText(obj);

      fields.push({
        name: obj.name,
        type: text ? "text" : video ? "video" : image ? "image" : "shape",
        defaultValue: text
          ? obj.text || ""
          : video
            ? obj.videoSrc || ""
            : image
              ? obj.src || ""
              : obj.fill || "#000000",
        properties: {
          fontFamily: obj.fontFamily,
          fontSize: obj.fontSize,
          fontWeight: obj.fontWeight,
          fill: obj.fill,
          textAlign: obj.textAlign,
          duration: obj.videoDuration,
          hasAudio: obj.hasAudio,
          posterUrl: obj.posterUrl || obj.src,
          trimStart: obj.trimStart,
          trimEnd: obj.trimEnd,
          startAt: obj.startAt,
        },
      });
    }
  });

  return fields;
}
