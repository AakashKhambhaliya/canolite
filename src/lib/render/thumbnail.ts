/**
 * Template thumbnail generation.
 *
 * The templates grid reads `templates.thumbnail_url`. Nothing populated it
 * until this module existed, which is why every card showed a placeholder.
 */
import { promises as fsPromises } from "fs";
import path from "path";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { eq, and, isNull, sql, getTableColumns } from "drizzle-orm";
import { prepareDesignForRender } from "./prepare-design";
import { renderToBuffer } from "./render-image";
import { uploadFile, deleteFile, storageFilePath } from "@/lib/storage";

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

// De-duplicate concurrent generation for the same template. Without this, two
// triggers arriving together (a save racing the boot sweep, say) would launch
// duplicate Chromium renders for the same in-flight request. It does NOT make
// later calls redundant in general: if a save commits a new design while a
// render for an older version of that row is still in flight, the pending
// promise represents stale work. The conditional UPDATE below detects that
// case (the row moved on) and re-renders against the fresh row instead of
// letting the stale render win. Mirrors the in-flight promise caching in
// getBrowser() (render-image.ts) and ensureFont() (editor/font-loader.ts).
const inflight = new Map<string, Promise<void>>();

/** Maximum re-render attempts when the template keeps changing mid-render. */
const MAX_RENDER_ATTEMPTS = 3;

/**
 * Remove every thumbnail file for this template other than the one just
 * written. Keeps the storage/thumbnails directory from accumulating orphans
 * left by superseded renders, template edits, and (via the caller) deletes.
 * Best-effort: a failure here must never surface as a generation failure.
 */
async function cleanupStaleThumbnails(
  templateRowId: string,
  currentKey: string
): Promise<void> {
  try {
    const dir = storageFilePath("thumbnails");
    const entries = await fsPromises.readdir(dir);
    const prefix = `${templateRowId}-`;
    const currentName = path.basename(currentKey);
    for (const entry of entries) {
      if (entry.startsWith(prefix) && entry !== currentName) {
        await deleteFile(`thumbnails/${entry}`);
      }
    }
  } catch (err: any) {
    // Missing directory, permission error, etc. — nothing to clean up (or
    // nothing we can do about it). Never let this fail generation.
    console.error(
      `[thumbnail] Cleanup failed for template ${templateRowId}:`,
      err?.message || err
    );
  }
}

/**
 * Render a template's design to a thumbnail, store it, and point
 * `templates.thumbnail_url` at it.
 *
 * The final write is conditioned on the row's `updatedAt` being unchanged
 * since the render started. If another save committed a newer design while
 * this render was in flight, the conditional UPDATE affects zero rows and the
 * function re-renders against the fresh row instead, up to
 * MAX_RENDER_ATTEMPTS times — so a superseded render can never overwrite a
 * newer one's URL.
 *
 * Always resolves. A failure is logged and leaves `thumbnail_url` NULL, so the
 * grid keeps showing its placeholder and the next boot sweep retries.
 */
export async function generateThumbnail(templateRowId: string): Promise<void> {
  const existing = inflight.get(templateRowId);
  if (existing) return existing;

  const p = (async () => {
    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
      const [template] = await db
        .select({
          ...getTableColumns(templates),
          // The row version as Postgres itself stores it. A JS Date cannot
          // round-trip this column: `updated_at` is `timestamp` (no time zone,
          // microsecond precision), but a Date only carries milliseconds AND
          // the driver re-binds it as a UTC "…Z" string, which Postgres then
          // compares in a different frame of reference. Either error alone
          // makes an equality guard match zero rows, so keep the exact text.
          updatedAtRaw: sql<string>`to_char(${templates.updatedAt}, 'YYYY-MM-DD HH24:MI:SS.US')`,
        })
        .from(templates)
        .where(eq(templates.id, templateRowId))
        .limit(1);

      if (!template || template.isDeleted) return;
      if (!template.designJson) return;

      // Snapshot the version we're rendering. The final UPDATE only applies
      // if the row is still at this version when the render completes.
      const snapshot = template.updatedAt;
      const snapshotRaw = template.updatedAtRaw;

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

      const key = thumbnailKey(template.id, snapshot);
      const url = await uploadFile(key, buffer, "image/webp");

      const updated = await db
        .update(templates)
        .set({ thumbnailUrl: url })
        .where(
          and(
            eq(templates.id, template.id),
            // Compare the stored text, NOT eq(templates.updatedAt, snapshot):
            // that guard could never match (see updatedAtRaw above), so
            // thumbnail_url stayed NULL for every template forever and each
            // boot burned MAX_RENDER_ATTEMPTS Chromium renders per template
            // before giving up with "design kept changing mid-render".
            sql`to_char(${templates.updatedAt}, 'YYYY-MM-DD HH24:MI:SS.US') = ${snapshotRaw}`
          )
        )
        .returning({ id: templates.id });

      if (updated.length > 0) {
        await cleanupStaleThumbnails(template.id, key);
        return;
      }

      // The design changed underneath us mid-render: this render's bytes are
      // stale and were never linked from the row. Discard the file and loop
      // to render the fresh version instead.
      await deleteFile(key);
    }

    console.error(
      `[thumbnail] Gave up on template ${templateRowId} after ${MAX_RENDER_ATTEMPTS} attempts: design kept changing mid-render.`
    );
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

/**
 * Generate thumbnails for every template that lacks one.
 *
 * Runs at boot so templates created before thumbnails existed (or whose
 * generation previously failed) get one with no manual step. Serial on purpose:
 * each thumbnail is a headless Chromium render, and a parallel sweep over a
 * large library would starve request handling.
 */
export async function backfillThumbnails(): Promise<void> {
  const rows = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(isNull(templates.thumbnailUrl), eq(templates.isDeleted, false)));

  if (rows.length === 0) return;

  console.log(`[thumbnail] Backfilling ${rows.length} template(s)…`);
  let done = 0;
  for (const row of rows) {
    // generateThumbnail never rejects, but guard anyway so one bad template
    // can't abort the sweep.
    await generateThumbnail(row.id).catch(() => {});
    done++;
  }
  console.log(`[thumbnail] Backfill complete (${done}/${rows.length}).`);
}
