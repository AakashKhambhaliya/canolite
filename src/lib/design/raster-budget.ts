// Bound the actual raster, not just the artboard dimensions. A 4× export
// needs sixteen times as many pixels; mobile browsers can run out of memory
// before toBlob has a chance to report failure.
export function rasterExportIssue(
  width: number,
  height: number,
  scale: number,
): string | null {
  const w = width * scale,
    h = height * scale;
  return !Number.isSafeInteger(w) ||
    !Number.isSafeInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > 16384 ||
    h > 16384 ||
    w * h > 32_000_000
    ? "This raster export is too large (32 MP or 16,384 px per side). Choose a smaller scale, resize the artboard, or export SVG."
    : null;
}
