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
import { collectFamilies, type CustomFontRef } from "./render-image";
import { fontsWithCustom } from "./apply-modifications";

export interface PreparedDesign {
  designJson: any;
  customFonts: CustomFontRef[];
}

/**
 * Font families a render for this project can use: the default render fonts
 * plus the project's uploaded fonts (family = file name without extension,
 * the same rule prepareDesignForRender uses to load them).
 */
export async function availableFontsForProject(projectId: string): Promise<Set<string>> {
  const fontAssets = await db
    .select({ name: assets.name })
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.type, "font")));
  return fontsWithCustom(fontAssets.map((a: any) => String(a.name).replace(/\.[^.]+$/, "")));
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

  const needed = new Set(collectFamilies(prepared));
  const customFonts = await inlineFontSources(
    fontAssets.map((a: any) => ({
      family: a.name.replace(/\.[^.]+$/, ""),
      url: a.url,
    })).filter(f => needed.has(f.family))
  );

  return { designJson: prepared, customFonts };
}
