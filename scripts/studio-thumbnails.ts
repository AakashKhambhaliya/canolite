// Regenerate the library thumbnails from the actual editable Fabric designs.
// Run after `npx playwright install chromium`: npx tsx scripts/studio-thumbnails.ts
import { CANOLITE_ORIGIN } from "../src/lib/editor/fabric-defaults";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { STUDIO_PRESETS } from "../src/lib/editor/studio-presets";
async function main() {
  await mkdir("public/studio/thumbs", { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas id="art"></canvas>');
    await page.addScriptTag({ path: "node_modules/fabric/dist/index.min.js" });
    await page.evaluate((origin) => {
      Object.assign(
        (window as any).fabric.BaseFabricObject.ownDefaults,
        origin,
      );
    }, CANOLITE_ORIGIN);
    for (const p of STUDIO_PRESETS) {
      const objects = await Promise.all(
        p.objects.map(async (o) =>
          typeof o.src === "string" && o.src.startsWith("/studio/")
            ? {
                ...o,
                src: `data:image/webp;base64,${(await readFile(`public${o.src}`)).toString("base64")}`,
              }
            : o,
        ),
      );
      const data = await page.evaluate(
        async ({ objects, p }) => {
          const { StaticCanvas } = (window as any).fabric;
          const c = new StaticCanvas(document.createElement("canvas"), {
            width: p.width,
            height: p.height,
          });
          await c.loadFromJSON({ objects, background: p.background });
          c.renderAll();
          const url = c.toDataURL({
            format: "webp",
            multiplier: 0.44,
            quality: 0.9,
          });
          await c.dispose();
          return url.split(",")[1];
        },
        { objects, p },
      );
      await writeFile(
        `public/studio/thumbs/${p.id}.webp`,
        Buffer.from(data, "base64"),
      );
      console.log(`Rendered ${p.name}`);
    }
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
