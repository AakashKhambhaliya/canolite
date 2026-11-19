export type Artwork = {
  [key: string]: unknown;
  objects?: Artwork[];
  clipPath?: Artwork;
  backgroundImage?: Artwork;
  overlayImage?: Artwork;
};
type Loaded = {
  getObjects?: () => Loaded[];
  clipPath?: Loaded;
  backgroundImage?: Loaded;
  overlayImage?: Loaded;
};
/** Intentionally closure-free: Playwright also installs this verifier inside
 * the isolated browser pages that render stills and video. */
export function createArtworkVerifier() {
  return function verifyTree(source: Artwork, loaded: Loaded | undefined) {
    if (!loaded) throw new Error("A layer could not be opened.");
    if (source.objects !== undefined) {
      const items = loaded.getObjects?.() || [];
      if (
        !Array.isArray(source.objects) ||
        source.objects.length !== items.length
      ) {
        // Fabric silently drops a layer whose image fails to load, so the
        // counts differ. Name the image layers — the usual culprits — so the
        // caller (dashboard, API, n8n) can tell which source to fix.
        const images = (Array.isArray(source.objects) ? source.objects : [])
          .filter((o) => /^image$/i.test(String(o?.type ?? "")))
          .map((o) => {
            const name = typeof o.name === "string" && o.name ? `"${o.name}"` : "unnamed";
            const src = typeof o.src === "string" ? o.src.slice(0, 120) : "";
            return src && !src.startsWith("data:") ? `${name} (${src})` : name;
          });
        throw new Error(
          "Some layers could not be opened." +
            (images.length
              ? ` Check that these image layers point to an uploaded file or a public image URL: ${images.slice(0, 5).join(", ")}.`
              : "")
        );
      }
      source.objects.forEach((obj, i) => verifyTree(obj, items[i]));
    }
    for (const key of [
      "clipPath",
      "backgroundImage",
      "overlayImage",
    ] as const) {
      if (source[key]) verifyTree(source[key], loaded[key]);
    }
  };
}
