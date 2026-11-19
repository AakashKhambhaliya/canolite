import {
  createArtworkVerifier,
  type Artwork,
} from "@/lib/design/loaded-artwork";
import type { Canvas, StaticCanvas as FabricStaticCanvas } from "fabric";

export { rasterExportIssue } from "@/lib/design/raster-budget";

/** Fit/zoom changes must not allocate a pair of native-size Retina surfaces. */
export function maxDisplayZoom(w: number, h: number, dpr: number) {
  return (
    Math.min(8192 / Math.max(w, h), Math.sqrt(12_000_000 / (w * h))) /
    Math.max(1, dpr)
  );
}

export function pushSnapshot(
  stack: string[],
  index: number,
  entry: string,
  maxChars = 16_000_000,
) {
  const next = stack.slice(0, index + 1);
  next.push(entry);
  let chars = entry.length,
    first = next.length - 1;
  while (
    first > 0 &&
    next.length - first < 80 &&
    chars + next[first - 1].length <= maxChars
  ) {
    chars += next[--first].length;
  }
  return next.slice(first);
}

const verifyTree = createArtworkVerifier();

/** Load off-screen and validate before touching the live document. Fabric 7
 * can omit unavailable images (also inside groups) instead of throwing. An
 * incomplete open/undo must never be offered as a document that can be saved. */
export async function loadArtwork(
  canvas: Canvas,
  document: Artwork,
  signal: AbortSignal,
) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error("Invalid artwork");
  signal.throwIfAborted();
  const { StaticCanvas } = await import("fabric");
  const stage: FabricStaticCanvas = new StaticCanvas(undefined, {
    width: 1,
    height: 1,
    renderOnAddRemove: false,
    enableRetinaScaling: false,
  });
  try {
    await stage.loadFromJSON(
      document,
      (_raw, obj, error) => {
        if (!obj || error)
          throw new Error("A design layer could not be loaded.");
      },
      { signal },
    );
    signal.throwIfAborted();
    verifyTree(document, stage);
    // Transfer ownership before disposing the staging canvas. Do not resize
    // the live DOM canvas or carry over an old editor viewport transform.
    const items = stage.remove(...stage.getObjects());
    const image = stage.backgroundImage,
      overlay = stage.overlayImage,
      clip = stage.clipPath;
    stage.backgroundImage = stage.overlayImage = stage.clipPath = undefined;
    const old = [
      ...canvas.getObjects(),
      canvas.backgroundImage,
      canvas.overlayImage,
      canvas.clipPath,
    ];
    canvas.discardActiveObject();
    canvas.clear();
    canvas.set({
      backgroundColor: stage.backgroundColor,
      overlayColor: stage.overlayColor,
      backgroundImage: image,
      overlayImage: overlay,
      clipPath: clip,
      backgroundVpt: stage.backgroundVpt,
      overlayVpt: stage.overlayVpt,
    });
    image?.set("canvas", canvas);
    overlay?.set("canvas", canvas);
    canvas.add(...items);
    canvas.requestRenderAll();
    for (const obj of new Set(old)) obj?.dispose();
  } finally {
    await stage.dispose();
  }
}
