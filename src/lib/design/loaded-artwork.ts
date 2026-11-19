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
      )
        throw new Error("Some layers could not be opened.");
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
