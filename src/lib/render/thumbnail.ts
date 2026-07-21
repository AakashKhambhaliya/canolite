/**
 * Template thumbnail generation.
 *
 * The templates grid reads `templates.thumbnail_url`. Nothing populated it
 * until this module existed, which is why every card showed a placeholder.
 */

/** Longest edge of a generated thumbnail, in pixels. */
export const THUMBNAIL_MAX_EDGE = 400;

/**
 * Storage key for a template's thumbnail.
 *
 * `updatedAt` is part of the filename so that editing a template yields a new
 * URL. Stored files are served with `Cache-Control: immutable`, so without this
 * a browser would keep showing the previous preview forever.
 */
export function thumbnailKey(templateRowId: string, updatedAt: Date): string {
  return `thumbnails/${templateRowId}-${updatedAt.getTime()}.webp`;
}

/**
 * Render multiplier that fits the design's longest edge to THUMBNAIL_MAX_EDGE.
 * Never upscales — a design smaller than the target renders at its native size.
 */
export function thumbnailScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return 1;
  return Math.min(1, THUMBNAIL_MAX_EDGE / longest);
}
