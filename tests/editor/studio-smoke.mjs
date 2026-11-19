// Integration check against the normal, running Canolite app, using an isolated
// template in a disposable test workspace. Never open or edit a user's design.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { dashboardPalette, checkEditorPalette } from "./studio-theme.mjs";
const { CANOLITE_TEST_EMAIL: email, CANOLITE_TEST_PASSWORD: password } =
  process.env;
if (!email || !password)
  throw new Error("Provide credentials for a disposable test workspace.");
const browser = await chromium.launch();
const page = await browser.newPage({
  baseURL: process.env.STUDIO_TEST_URL || "http://127.0.0.1:3000",
  viewport: { width: 1280, height: 800 },
});
let testTemplateId;
try {
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const title = async (name) =>
    page.waitForFunction(
      (s) => document.querySelector(".sl-document")?.textContent === s,
      name,
    );
  const openPanel = async (name) => {
    if (
      !(await page
        .getByRole("complementary", { name: `${name} panel` })
        .isVisible())
    )
      await page
        .getByRole("navigation", { name: "Editor tools" })
        .getByRole("button", { name, exact: true })
        .click();
  };
  await page.goto("/login");
  await page.getByLabel("Admin email", { exact: true }).fill(email);
  await page.getByLabel("Admin password", { exact: true }).fill(password);
  await button("Sign in").click();
  await page.getByRole("heading", { name: "Templates", exact: true }).waitFor();
  const palette = await dashboardPalette(page);
  const testName = `Editor smoke ${randomUUID()}`;
  const response = await page.request.post("/api/templates", {
    data: { name: testName, width: 1080, height: 1350 },
  });
  assert.equal(response.status(), 201);
  testTemplateId = (await response.json()).id;
  await page.reload();
  await page.getByRole("heading", { name: testName, exact: true }).click();
  await page.locator(".sl-artboard:visible").waitFor();
  assert.equal(await page.locator(".sl-template").count(), 6);
  await button("Social").click();
  assert.equal(await page.locator(".sl-template").count(), 2);
  await button("All").click();
  await page.keyboard.press("/");
  await page.keyboard.type("Alpine");
  assert.equal(await page.locator(".sl-template").count(), 1);
  await button("Clear search").click();
  assert.equal(await page.locator(".sl-template").count(), 6);
  console.log("✓ Search and category filters");
  await button("Use Alpine Escape template").click();
  await button("Use template").click();
  await title("Alpine Escape");
  await checkEditorPalette(page, palette);
  await button("Use Citrus Club template").click();
  await button("Use template").click();
  await title("Citrus Club");
  await button("Undo (Ctrl/⌘ Z)").click();
  await title("Alpine Escape");
  assert.match(await page.locator(".sl-art-label").innerText(), /1080 × 1350/);
  await button("Redo (Ctrl/⌘ Shift Z)").click();
  await title("Citrus Club");
  assert.match(await page.locator(".sl-art-label").innerText(), /1080 × 1080/);
  console.log(
    "✓ Template replacement, undo and redo restore artboard metadata",
  );
  await openPanel("Elements");
  await button("Rectangle").click();
  await button("Edit layer").click();
  await page.getByLabel("Fill color", { exact: true }).fill("#385577");
  await openPanel("Layers");
  await button("Lock rectangle").click();
  await button("Unlock rectangle").click();
  await button("Hide rectangle").click();
  await button("Show rectangle").click();
  await page
    .locator(".sl-layer-title")
    .filter({ hasText: "rectangle" })
    .click();
  await button("Backward").click();
  assert.match(
    await page.locator(".sl-layer-title").nth(1).innerText(),
    /rectangle/,
  );
  await button("Undo (Ctrl/⌘ Z)").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".sl-layer-title")?.textContent === "rectangle",
  );
  console.log(
    "✓ Shape insertion, color, visibility, locking, stacking and history",
  );
  await openPanel("Text");
  await button("Add a heading +").click();
  await button("Edit text").click();
  await page
    .getByLabel("Text content", { exact: true })
    .fill("A different horizon");
  await button("Italic").click();
  await button("Duplicate selection").click();
  await button("Delete selection").click();
  await page.locator(".sl-document").click();
  await page.getByRole("menuitem", { name: "Rename design" }).click();
  await page.getByLabel("Design name").fill("Field Notes");
  await page.getByLabel("Design name").press("Enter");
  await title("Field Notes");
  await page.keyboard.press("Control+s");
  await page.locator(".sl-save:not(.is-dirty)").waitFor();
  await page.reload();
  await page.locator(".sl-artboard:visible").waitFor();
  await title("Field Notes");
  await openPanel("Layers");
  await page
    .locator(".sl-layer-title")
    .filter({ hasText: /^heading$/ })
    .click();
  await button("Edit layer properties").click();
  assert.equal(
    await page.getByLabel("Text content", { exact: true }).inputValue(),
    "A different horizon",
  );
  console.log("✓ Text editing, duplication, deletion, rename, save and reopen");
  await page.keyboard.press("Escape");
  await button("Resize").click();
  await page.getByLabel("Width (px)").fill("800");
  await page.getByLabel("Height (px)").fill("1000");
  await button("Resize artboard").click();
  await page.waitForFunction(() =>
    document.querySelector(".sl-art-label")?.textContent.includes("800 × 1000"),
  );
  await button("Preview design").click();
  assert.equal(
    await page.getByRole("toolbar", { name: "Canvas tools" }).count(),
    0,
  );
  await button("Back to editor").click();
  await button("Zoom in").click();
  await page.locator(".sl-zoom-value").click();
  await button("Focus mode (F)").click();
  assert.equal(
    await page.getByRole("navigation", { name: "Editor tools" }).count(),
    0,
  );
  await button("Exit focus mode").click();
  await button("Export").click();
  await button("PNG").click();
  await button("1×").click();
  const dl = page.waitForEvent("download");
  await button("Export PNG").click();
  const download = await dl;
  const bytes = await readFile(await download.path());
  assert.equal(bytes.readUInt32BE(16), 800);
  assert.equal(bytes.readUInt32BE(20), 1000);
  assert.equal(download.suggestedFilename(), "Field Notes.png");
  console.log("✓ Resize, preview, zoom, focus and exact-size PNG download");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !document.querySelector(".sl-panel"));
  await openPanel("Templates");
  await button("Use After Hours template").click();
  await button("Use template").click();
  await title("After Hours");
  assert.equal(await page.locator(".sl-panel").count(), 0);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  console.log("✓ Mobile bottom tools and dismissible library");
  assert.deepEqual(errors, []);
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.keyboard.press("Control+s");
  await page.locator(".sl-save:not(.is-dirty)").waitFor();
  await button("Back to Templates dashboard").click();
  await page.getByRole("heading", { name: "Templates", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  const stored = await (
    await page.request.get(`/api/templates/${testTemplateId}`)
  ).json();
  assert.equal(stored.name, "After Hours");
  console.log(
    "✓ Original dashboard → integrated editor → saved template → original dashboard",
  );
} finally {
  try {
    if (testTemplateId)
      await page.request.delete(`/api/templates/${testTemplateId}`);
  } finally {
    await browser.close();
  }
}
