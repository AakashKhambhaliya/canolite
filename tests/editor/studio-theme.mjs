// Compare against the actual dashboard, not hard-coded swatches. The .dark
// class is the app's theme contract; there is no editor-only theme switch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

async function theme(page, dark) {
  await page.mouse.move(0, 0);
  await page.evaluate(async (enabled) => {
    document.documentElement.classList.toggle("dark", enabled);
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => a.finished),
    );
  }, dark);
}

// CSS can serialize equivalent colors as oklch(), rgb() or color-mix().
async function color(locator, property = "backgroundColor") {
  return locator.evaluate((el, key) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = getComputedStyle(el)[key];
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(",");
  }, property);
}

export async function dashboardPalette(page) {
  const result = [];
  const sidebar = page.locator("aside");
  const navItem = sidebar.getByRole("link", { name: "Templates", exact: true });
  const action = page
    .getByRole("button", { name: "New Template", exact: true })
    .first();
  try {
    for (const dark of [false, true]) {
      await theme(page, dark);
      const palette = {
        dark,
        action: await color(action),
        surface: await color(sidebar),
        workspace: await color(sidebar.locator("..")),
        line: await color(sidebar, "borderRightColor"),
        active: await color(navItem),
        activeInk: await color(navItem, "color"),
      };
      await action.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      palette.dialog = await color(dialog);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      result.push(palette);
    }
  } finally {
    await theme(page, false);
  }
  assert.notEqual(
    result[0].surface,
    result[1].surface,
    "Dashboard dark class must change its surfaces.",
  );
  return result;
}

export async function checkEditorPalette(page, palettes) {
  let firstPixels;
  const button = (name) => page.getByRole("button", { name, exact: true });
  try {
    for (const p of palettes) {
      await theme(page, p.dark);
      for (const selector of [
        ".sl-header",
        ".sl-panel",
        ".sl-rail",
        ".sl-toolbar",
        ".sl-status",
      ]) {
        assert.equal(
          await color(page.locator(selector)),
          p.surface,
          `${selector} must match dashboard chrome (dark=${p.dark})`,
        );
      }
      assert.equal(await color(page.locator(".sl-stage")), p.workspace);
      assert.equal(
        await color(page.locator(".sl-header"), "borderBottomColor"),
        p.line,
      );
      assert.equal(await color(button("Export")), p.action);
      const active = page.locator('.sl-rail-item[aria-pressed="true"]');
      assert.equal(await color(active.locator("span")), p.active);
      assert.equal(await color(active, "color"), p.activeInk);
      await button("Export").click();
      const dialog = page.getByRole("dialog");
      assert.equal(
        await color(dialog),
        p.dialog,
        "Portaled dialog must also follow the app theme.",
      );
      await button("PNG").click();
      await button("1×").click();
      const download = page.waitForEvent("download");
      await button("Export PNG").click();
      const buffer = await readFile(await (await download).path());
      const pixels = await sharp(buffer).ensureAlpha().raw().toBuffer();
      const hash = createHash("sha256").update(pixels).digest("hex");
      if (firstPixels)
        assert.equal(
          hash,
          firstPixels,
          "The UI theme must never recolor exported artwork.",
        );
      firstPixels = hash;
      await dialog.waitFor({ state: "detached" });
    }
  } finally {
    await theme(page, false);
  }
  console.log(
    "✓ Editor chrome and dialogs match dashboard colors in light and dark; exported design pixels are identical.",
  );
}
