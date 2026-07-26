/**
 * Prepare a design for headless rendering.
 *
 * Two things must happen before a design can be painted in the render page:
 *
 *  - external image URLs are fetched server-side and inlined as data: URLs
 *    (the page can't reliably load arbitrary external URLs), and
 *  - custom font bytes are inlined as data: URLs (the render page has an
 *    opaque origin, so CORS blocks font fetches — see inline-fonts.ts).
 *
 * Both the render worker and the thumbnail generator need exactly this, so it
 * lives here rather than being duplicated.
 */
import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { inlineExternalImages } from "./inline-images";
import { inlineFontSources } from "./inline-fonts";
import type { CustomFontRef } from "./render-image";

export interface PreparedDesign {
  designJson: any;
  customFonts: CustomFontRef[];
}

export async function prepareDesignForRender(
  designJson: any,
  projectId: string
): Promise<PreparedDesign> {
  const prepared = await inlineExternalImages(designJson);

  const fontAssets = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.type, "font")));

  const customFonts = await inlineFontSources(
    fontAssets.map((a: any) => ({
      family: a.name.replace(/\.[^.]+$/, ""),
      url: a.url,
    }))
  );

  return { designJson: prepared, customFonts };
}
