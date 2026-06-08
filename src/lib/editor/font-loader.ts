/**
 * Font loading for the editor.
 *
 *  - Google Fonts: injected on demand via the css2 stylesheet API.
 *  - Custom fonts: registered from an uploaded file URL via the FontFace API.
 *
 * All loads are de-duplicated and return a promise that resolves once the font
 * is actually ready to paint, so callers can re-render the canvas afterwards.
 */
import googleFontsRaw from "./google-fonts.json";

export interface GoogleFont {
  family: string;
  weights: number[];
  category: string;
}

export const GOOGLE_FONTS = googleFontsRaw as GoogleFont[];

const GOOGLE_FAMILY_SET = new Set(GOOGLE_FONTS.map((f) => f.family));
const GOOGLE_WEIGHTS = new Map(GOOGLE_FONTS.map((f) => [f.family, f.weights]));

// Fonts that ship with the OS / browser — never need network loading.
export const SYSTEM_FONTS = [
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "Verdana",
  "Trebuchet MS",
  "Impact",
  "Comic Sans MS",
  "Palatino",
];
const SYSTEM_FONT_SET = new Set(SYSTEM_FONTS);

const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

export function isGoogleFont(family: string): boolean {
  return GOOGLE_FAMILY_SET.has(family);
}

function familyToParam(family: string): string {
  return family.replace(/ /g, "+");
}

/**
 * Ensure a font is available to paint. Resolves immediately for system fonts.
 */
export async function ensureFont(family: string): Promise<void> {
  if (!family || SYSTEM_FONT_SET.has(family) || loaded.has(family)) return;
  if (inflight.has(family)) return inflight.get(family)!;

  const p = (async () => {
    if (GOOGLE_FAMILY_SET.has(family)) {
      await loadGoogleFont(family);
    }
    // Custom fonts are registered separately via registerCustomFont().
    loaded.add(family);
  })();

  inflight.set(family, p);
  try {
    await p;
  } finally {
    inflight.delete(family);
  }
}

/** Inject the Google Fonts stylesheet for a family and wait for it to load. */
export async function loadGoogleFont(family: string): Promise<void> {
  if (typeof document === "undefined") return;
  const id = `gf-${family}`;
  if (!document.getElementById(id)) {
    const weights = GOOGLE_WEIGHTS.get(family) || [400, 700];
    const axis = weights.join(";");
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${familyToParam(
      family
    )}:wght@${axis}&display=swap`;
    document.head.appendChild(link);
  }
  await waitForFont(family);
}

/** Register an uploaded custom font from a file URL. */
export async function registerCustomFont(
  family: string,
  url: string
): Promise<void> {
  if (typeof document === "undefined" || loaded.has(family)) return;
  try {
    const face = new FontFace(family, `url(${url})`);
    await face.load();
    (document as any).fonts.add(face);
    loaded.add(family);
  } catch (e) {
    console.error(`Failed to load custom font "${family}":`, e);
  }
}

async function waitForFont(family: string): Promise<void> {
  try {
    const fonts: any = (document as any).fonts;
    if (!fonts) return;
    await Promise.race([
      fonts.load(`16px "${family}"`).then(() => fonts.ready),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch {
    // best-effort
  }
}
