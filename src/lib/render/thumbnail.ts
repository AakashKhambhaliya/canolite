/**
 * Template thumbnail generation.
 *
 * The templates grid reads `templates.thumbnail_url`. Nothing populated it
 * until this module existed, which is why every card showed a placeholder.
 */
import { db } from "@/db";
import { templates } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prepareDesignForRender } from "./prepare-design";
import { renderToBuffer } from "./render-image";
import { uploadFile } from "@/lib/storage";

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

// De-duplicate concurrent generation for the same template. Two triggers
// arriving together (a save racing the boot sweep, say) would otherwise both
// launch a Chromium render and write identical bytes. Mirrors the in-flight
// promise caching in getBrowser() (render-image.ts) and ensureFont()
// (editor/font-loader.ts).
const inflight = new Map<string, Promise<void>>();

/**
 * Render a template's design to a thumbnail, store it, and point
 * `templates.thumbnail_url` at it.
 *
 * Always resolves. A failure is logged and leaves `thumbnail_url` NULL, so the
 * grid keeps showing its placeholder and the next boot sweep retries.
 */
export async function generateThumbnail(templateRowId: string): Promise<void> {
  const existing = inflight.get(templateRowId);
  if (existing) return existing;

  const p = (async () => {
    const [template] = await db
      .select()
      .from(templates)
      .where(eq(templates.id, templateRowId))
      .limit(1);

    if (!template || template.isDeleted) return;
    if (!template.designJson) return;

    const { designJson, customFonts } = await prepareDesignForRender(
      template.designJson,
      template.projectId
    );

    const { buffer } = await renderToBuffer({
      designJson,
      width: template.width,
      height: template.height,
      format: "webp",
      quality: 80,
      scale: thumbnailScale(template.width, template.height),
      customFonts,
    });

    const key = thumbnailKey(template.id, template.updatedAt);
    const url = await uploadFile(key, buffer, "image/webp");

    await db
      .update(templates)
      .set({ thumbnailUrl: url })
      .where(eq(templates.id, template.id));
  })()
    .catch((err: any) => {
      // Degrade to the grid's placeholder rather than failing anything.
      console.error(
        `[thumbnail] Failed for template ${templateRowId}:`,
        err?.message || err
      );
    })
    .finally(() => {
      inflight.delete(templateRowId);
    });

  inflight.set(templateRowId, p);
  return p;
}
