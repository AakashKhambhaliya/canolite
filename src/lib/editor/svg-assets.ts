/** A downloaded SVG cannot resolve `/storage/...` against the Canolite host.
 * Inline only first-party stored images; do not proxy arbitrary external URLs.
 * A missing poster must fail the export instead of producing a broken file. */
export async function portableStorageImages(svg: string, signal?: AbortSignal) {
  const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (xml.querySelector("parsererror")) throw new Error("Invalid SVG document");
  const xlink = "http://www.w3.org/1999/xlink";
  const seen = new Map<string, string>();
  for (const image of xml.querySelectorAll("image")) {
    const href =
      image.getAttributeNS(xlink, "href") || image.getAttribute("href");
    if (!href || href.startsWith("data:")) continue;
    const url = new URL(href, window.location.href);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/storage/")
    )
      continue;
    let data = seen.get(url.href);
    if (!data) {
      const r = await fetch(url.href, {
        signal,
        mode: "same-origin",
        redirect: "error",
      });
      if (!r.ok) throw new Error("Image is unavailable");
      const blob = await r.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Expected an image");
      data = await new Promise<string>((yes, no) => {
        const reader = new FileReader();
        reader.onload = () => yes(String(reader.result));
        reader.onerror = () => no(Error("Could not read image"));
        reader.readAsDataURL(blob);
      });
      seen.set(url.href, data);
    }
    if (image.hasAttributeNS(xlink, "href"))
      image.setAttributeNS(xlink, "xlink:href", data);
    if (image.hasAttribute("href")) image.setAttribute("href", data);
  }
  return seen.size ? new XMLSerializer().serializeToString(xml) : svg;
}
