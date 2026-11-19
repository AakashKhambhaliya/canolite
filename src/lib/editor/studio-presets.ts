/** Studio originals. These are ordinary Fabric designs, not flattened posters.
 * All type is editable and named headlines are available to Canolite's API.
 * Intricate illustrations stay single replaceable image layers. */
export type StudioCategory = "Poster" | "Social" | "Print";
export interface StudioPreset {
  id: string;
  name: string;
  category: StudioCategory;
  description: string;
  width: number;
  height: number;
  background: string;
  objects: Record<string, unknown>[];
}
const ink = "#102c3c",
  cream = "#f8ecd2";
const base = {
  originX: "left",
  originY: "top",
  strokeWidth: 0,
  dynamic: false,
};
const text = (
  name: string,
  value: string,
  left: number,
  top: number,
  fontSize: number,
  opts: Record<string, unknown> = {},
) => ({
  ...base,
  type: "Textbox",
  name,
  text: value,
  left,
  top,
  fontSize,
  width: 995 - left,
  fontFamily: "Arial",
  fill: ink,
  lineHeight: 0.93,
  splitByGrapheme: false,
  styles: [],
  ...opts,
});
const micro = (
  name: string,
  value: string,
  x: number,
  y: number,
  opts: Record<string, unknown> = {},
) =>
  text(name, value, x, y, 24, {
    fontFamily: "Courier New",
    fontWeight: "bold",
    charSpacing: 80,
    ...opts,
  });
const rect = (
  name: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fill: string,
) => ({
  ...base,
  type: "Rect",
  name,
  left,
  top,
  width,
  height,
  fill,
});
const image = (
  name: string,
  src: string,
  width: number,
  height: number,
  left = 0,
  top = 0,
) => ({
  ...base,
  type: "Image",
  name,
  src,
  width,
  height,
  left,
  top,
  crossOrigin: "anonymous",
  filters: [],
});
export const svgURI = (w: number, h: number, content: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${content}</svg>`)}`;
const arch = (x: number, y: number, s: number, flip: boolean, color: string) =>
  `<g transform="translate(${x} ${y}) scale(${s})${flip ? " translate(200 200) rotate(180)" : ""}">${[190, 160, 130, 100, 70, 40].map((r) => `<path d="M 0 ${200 - r} A ${r} ${r} 0 0 1 ${r} 200" stroke="${color}" stroke-width="17" fill="none"/>`).join("")}</g>`;
const forma = svgURI(
  940,
  880,
  `<defs><clipPath id="c"><rect width="940" height="880"/></clipPath></defs><g clip-path="url(#c)">${arch(0, 0, 2.35, false, "#271d18")}${arch(470, 0, 2.35, true, "#fff0cf")}${arch(0, 470, 2.35, true, "#fff0cf")}${arch(470, 470, 2.35, false, "#271d18")}</g>`,
);
const flower = (
  cx: number,
  cy: number,
  radius: number,
  color: string,
  count = 8,
) =>
  Array.from(
    { length: count },
    (_, i) =>
      `<ellipse cx="${cx}" cy="${cy - radius * 0.5}" rx="${radius * 0.32}" ry="${radius * 0.58}" transform="rotate(${(i * 360) / count} ${cx} ${cy})" fill="${color}"/>`,
  ).join("");
const citrus = svgURI(
  880,
  630,
  `<g transform="rotate(-16 440 315)"><path d="M360 220 Q420 35 645 56 Q551 255 360 220" fill="#456738"/><path d="M366 198 Q220 35 87 90 Q178 254 366 198" fill="#263f2c"/><ellipse cx="342" cy="386" rx="239" ry="206" fill="#ee6b24"/><path d="M151 324 Q206 214 318 216" stroke="#f9953e" stroke-width="20" fill="none" stroke-linecap="round"/><circle cx="600" cy="390" r="210" fill="#e55c18"/><circle cx="600" cy="390" r="191" fill="#fff0c4"/>${Array.from({ length: 10 }, (_, i) => `<path d="M 610 373 L 618 220 Q 664 220 697 249 L 626 378 Z" transform="rotate(${i * 36} 600 390)" fill="${i % 3 ? "#f9952e" : "#f7b543"}"/>`).join("")}</g>`,
);
const orbit = svgURI(
  1000,
  760,
  `<g transform="rotate(-32 500 380)" fill="none" stroke="#c5a9f4" stroke-width="12">${Array.from({ length: 14 }, (_, i) => `<ellipse cx="${324 + i * 23}" cy="${319 + i * 7}" rx="${286 + i * 2}" ry="${88 + i * 7}"/>`).join("")}</g>`,
);
const coast = svgURI(
  1000,
  860,
  `<circle cx="247" cy="188" r="107" fill="#ffd65f"/>${Array.from({ length: 19 }, (_, i) => `<path d="M -80 ${270 + i * 28} Q 200 ${10 + i * 28} 510 ${270 + i * 28} T 1160 ${270 + i * 28}" fill="none" stroke="#e9f0e0" stroke-width="${8 + (i % 3)}"/>`).join("")}`,
);
const bloom = svgURI(
  830,
  880,
  `<path d="M436 358 Q420 630 320 864 M397 696 Q610 650 648 462 Q464 473 397 696 M408 626 Q239 546 159 391 Q356 410 408 626" fill="#89372e" stroke="#89372e" stroke-width="18"/>${flower(470, 305, 254, "#db452e", 7)}<circle cx="470" cy="305" r="75" fill="#7b332b"/>`,
);
const mountainMark = svgURI(
  77,
  43,
  `<path d="M3 39 25 4 47 39 Z M33 39 53 10 73 39 Z" stroke="${ink}" stroke-width="5" fill="none"/><path d="m18 16 7 5 6-5" fill="none" stroke="${ink}" stroke-width="4"/>`,
);
export const STUDIO_PRESETS: StudioPreset[] = [
  {
    id: "alpine",
    name: "Alpine Escape",
    category: "Poster",
    description:
      "A screen-printed alpine landscape with editable editorial type.",
    width: 1080,
    height: 1350,
    background: "#f4e7c9",
    objects: [
      {
        ...image("alpine_landscape", "/studio/alpine.webp", 1080, 1350),
        id: "studio-alpine-art",
        selectable: false,
        evented: false,
      },
      image("mountain_mark", mountainMark, 77, 43, 60, 56),
      micro("series", "FIELDNOTES  /  TRAVEL SERIES", 153, 65, {
        fontSize: 20,
        width: 701,
        charSpacing: 90,
      }),
      micro("edition", "Nº 001", 780, 62, {
        width: 240,
        textAlign: "right",
        fontSize: 22,
      }),
      text("headline", "Alpine", 49, 125, 200, {
        width: 957,
        fontFamily: "Times New Roman",
        fontWeight: "bold",
        charSpacing: -74,
        dynamic: true,
      }),
      text("subtitle", "Escape", 55, 295, 198, {
        width: 948,
        fontFamily: "Times New Roman",
        fontStyle: "italic",
        charSpacing: -53,
        dynamic: true,
      }),
      micro("kicker", "A FIELD GUIDE TO HIGHER PLACES", 66, 535, {
        fontSize: 19,
        charSpacing: 105,
      }),
      rect("footer_rule", 59, 1209, 962, 2, cream),
      text("location", "The Swiss Alps", 58, 1231, 55, {
        fill: cream,
        fontFamily: "Times New Roman",
        fontStyle: "italic",
        width: 590,
        dynamic: true,
      }),
      micro("coordinates", "46°33′ N\n08°33′ E", 747, 1238, {
        width: 270,
        textAlign: "right",
        fontSize: 22,
        fill: cream,
        lineHeight: 1.08,
        charSpacing: 95,
      }),
    ],
  },
  {
    id: "forma",
    name: "Forma Study",
    category: "Print",
    description:
      "A geometric print exploring repetition, rhythm and negative space.",
    width: 1080,
    height: 1350,
    background: "#f37a3b",
    objects: [
      micro("collection", "GRAPHIC SYSTEMS     /     02", 58, 56, {
        fill: "#30221c",
      }),
      text("headline", "Forma", 49, 103, 230, {
        fontFamily: "Times New Roman",
        charSpacing: -69,
        fill: "#30221c",
        dynamic: true,
      }),
      {
        ...image("arch_study", forma, 940, 880, 70, 377),
        id: "studio-forma-art",
      },
      rect("rule", 58, 1278, 964, 3, "#30221c"),
      micro("colophon", "STUDIES IN FORM", 59, 1296, {
        fontSize: 20,
        fill: "#30221c",
      }),
    ],
  },
  {
    id: "citrus",
    name: "Citrus Club",
    category: "Social",
    description: "A sunny, citrus-filled announcement for the weekend market.",
    width: 1080,
    height: 1080,
    background: "#f8e6ad",
    objects: [
      micro("series", "THE WEEKEND MARKET    /    EST. 1984", 67, 54, {
        fontSize: 22,
        fill: "#40523a",
      }),
      text("headline", "Citrus Club", 53, 113, 174, {
        fontFamily: "Times New Roman",
        fontWeight: "bold",
        charSpacing: -75,
        fill: "#264a34",
        dynamic: true,
        width: 1005,
      }),
      {
        ...image("citrus_illustration", citrus, 880, 630, 91, 285),
        id: "studio-citrus-art",
      },
      text("subtitle", "Freshly picked.", 66, 901, 67, {
        fill: "#294b37",
        fontFamily: "Times New Roman",
        fontStyle: "italic",
        dynamic: true,
      }),
      rect("bottom_rule", 66, 1003, 949, 3, "#40523a"),
      micro("number", "LOCAL PRODUCE   •   SERIES 03", 67, 1023, {
        fontSize: 19,
        fill: "#40523a",
      }),
    ],
  },
  {
    id: "after-hours",
    name: "After Hours",
    category: "Poster",
    description: "An orbital gig poster in midnight ink and electric lilac.",
    width: 1080,
    height: 1350,
    background: "#30263f",
    objects: [
      micro("venue", "SOUND DEPT.     /     LIVE SESSIONS", 58, 58, {
        fill: "#ceb5ef",
        fontSize: 22,
      }),
      text("headline", "After\nHours", 52, 164, 233, {
        fontFamily: "Times New Roman",
        fontStyle: "italic",
        lineHeight: 0.77,
        charSpacing: -80,
        fill: "#d4bef4",
        dynamic: true,
      }),
      {
        ...image("orbits", orbit, 1000, 760, 32, 474),
        id: "studio-after-hours-art",
      },
      rect("rule", 60, 1225, 960, 2, "#cab1ea"),
      micro("details", "FRIDAY  /  22:00", 58, 1262, {
        fill: "#d9c8ef",
        fontSize: 26,
      }),
    ],
  },
  {
    id: "coastal",
    name: "Coastal Notes",
    category: "Print",
    description: "A blue-and-cream tide study from the Coastline archive.",
    width: 1080,
    height: 1350,
    background: "#28528c",
    objects: [
      micro("archive", "COASTLINE ARCHIVE    /    05", 60, 55, {
        fill: "#e9f0e0",
      }),
      text("headline", "Coastal\nNotes", 54, 143, 198, {
        fontFamily: "Times New Roman",
        lineHeight: 0.8,
        charSpacing: -62,
        fill: "#e9f0e0",
        dynamic: true,
      }),
      {
        ...image("tide_study", coast, 1000, 860, 39, 408),
        id: "studio-coastal-art",
      },
      micro("edition", "WAVE STUDY     /     ATLANTIC COAST", 61, 1283, {
        fontSize: 20,
        fill: "#e9f0e0",
      }),
    ],
  },
  {
    id: "bloom",
    name: "In Bloom",
    category: "Social",
    description:
      "A botanical invitation with a sculptural flower and soft rose paper.",
    width: 1080,
    height: 1080,
    background: "#edc0bb",
    objects: [
      micro("series", "BOTANICAL EDITIONS    /    VI", 58, 53, {
        fill: "#813c37",
      }),
      {
        ...image("botanical_study", bloom, 830, 880, 148, 107),
        id: "studio-bloom-art",
      },
      text("headline", "In Bloom", 45, 775, 208, {
        width: 1006,
        fontFamily: "Times New Roman",
        fontStyle: "italic",
        charSpacing: -70,
        fill: "#5e2929",
        dynamic: true,
      }),
      micro("caption", "A SEASONAL STUDY", 61, 1019, {
        fontSize: 20,
        fill: "#813c37",
      }),
    ],
  },
];

/** Embed bundled art in the document, just like an image upload. The saved
 * design and its SVG export must not depend on the editor's origin. */
const embedded = new Map<string, Promise<string>>();
async function embed(url: string) {
  if (!embedded.has(url))
    embedded.set(
      url,
      (async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Could not load the illustration");
        const blob = await res.blob();
        return new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = reject;
          r.readAsDataURL(blob);
        });
      })().catch((e) => {
        embedded.delete(url);
        throw e;
      }),
    );
  return embedded.get(url)!;
}
export async function presetDesign(preset: StudioPreset) {
  const objects = await Promise.all(
    preset.objects.map(async (o) => ({
      ...o,
      ...(typeof o.src === "string" && o.src.startsWith("/studio/")
        ? { src: await embed(o.src) }
        : {}),
    })),
  );
  return { background: preset.background, objects };
}
export const STUDIO_GRAPHICS = [
  {
    name: "Sunburst",
    src: svgURI(
      200,
      200,
      `<path fill="#ea6c37" d="${Array.from({ length: 36 }, (_, i) => {
        const r = i % 2 ? 65 : 95;
        const a = (i * Math.PI) / 18;
        return `${i ? "L" : "M"}${100 + r * Math.cos(a)} ${100 + r * Math.sin(a)}`;
      }).join(" ")}Z"/>`,
    ),
  },
  {
    name: "Petals",
    src: svgURI(
      200,
      200,
      `${flower(100, 100, 85, "#a787ba")}<circle cx="100" cy="100" r="23" fill="#553f62"/>`,
    ),
  },
  { name: "Arch", src: svgURI(200, 200, arch(0, 0, 1, false, "#537363")) },
  { name: "Orbits", src: orbit },
  { name: "Citrus", src: citrus },
  { name: "Peaks", src: mountainMark },
];
