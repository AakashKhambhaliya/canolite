// Release regression tests. Only use an isolated, normally authenticated
// workspace (never the no-login guest preview). Every write targets a freshly
// created fixture. No account/instance settings are changed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";
const baseURL = process.env.STUDIO_TEST_URL || "http://127.0.0.1:3000";
const { CANOLITE_TEST_EMAIL: email, CANOLITE_TEST_PASSWORD: password } =
  process.env;
if (!email || !password) throw Error("Provide disposable test credentials.");
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
context.setDefaultTimeout(15000);
const ids = new Set();
const failures = [];
context.on("page", (p) => p.on("pageerror", (e) => failures.push(e.message)));
page.on("pageerror", (e) => failures.push(e.message));
const api = context.request;
const name = "Release check " + randomUUID().slice(0, 8);
async function editor(p, id) {
  await p.goto("/editor/" + id);
  await p.locator(".sl-artboard:visible").waitFor();
}
async function rename(p, n) {
  await p.locator(".sl-document").click();
  await p.getByRole("menuitem", { name: "Rename design" }).click();
  await p.getByLabel("Design name").fill(n);
  await p.getByLabel("Design name").press("Enter");
}
async function row(id) {
  const r = await api.get("/api/templates/" + id);
  assert.equal(r.status(), 200);
  return r.json();
}
async function save(p, id, code = 200) {
  const awaited = p.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      new URL(r.url()).pathname === "/api/templates/" + id,
  );
  await p.locator(".sl-save").click();
  assert.equal((await awaited).status(), code);
}
async function pixel(bytes, x, y, rgb) {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 256);
  assert.equal(info.height, 192);
  let i = (y * info.width + x) * info.channels;
  assert.deepEqual([...data.subarray(i, i + 3)], rgb);
}
try {
  assert.equal(
    (await api.get("/api/templates")).status(),
    401,
    "Release test requires the real auth boundary.",
  );
  assert.equal(
    (await api.post("/api/auth/login", { data: { email, password } })).status(),
    200,
  );
  const created = await api.post("/api/templates", {
    data: { name, width: 256, height: 192 },
  });
  assert.equal(created.status(), 201);
  const initial = await created.json();
  const id = initial.id;
  ids.add(id);
  // Old seed documents omit both origins. Fabric 7 defaults to center; verify
  // actual rendered pixels in the editor AND the independent server renderer.
  const design = {
    version: "5.3.0",
    background: "#ffffff",
    objects: [
      {
        type: "rect",
        left: 36,
        top: 26,
        width: 40,
        height: 30,
        fill: "#3264a0",
        strokeWidth: 0,
        name: "swatch",
        dynamic: true,
      },
    ],
  };
  assert.equal(
    (
      await api.put("/api/templates/" + id, {
        data: { designJson: design, expectedVersion: initial.version },
      })
    ).status(),
    200,
  );
  let thumb;
  for (let attempt = 0; attempt < 80; attempt++) {
    const t = await row(id);
    if (t.thumbnailUrl) {
      thumb = t.thumbnailUrl;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(thumb, "Thumbnail was not generated");
  const th = await api.get(thumb);
  assert.equal(th.status(), 200);
  const tp = await sharp(await th.body())
    .extract({ left: 70, top: 50, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert(
    [50, 100, 160].every((v, i) => Math.abs(tp[i] - v) < 14),
    "Unexpected thumbnail geometry",
  );
  await editor(page, id);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "PNG", exact: true }).click();
  await page.getByRole("button", { name: "1×", exact: true }).click();
  const got = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PNG" }).click();
  const dl = await got;
  await pixel(await readFile(await dl.path()), 70, 50, [50, 100, 160]);
  const rr = await api.post("/api/render", {
    data: { template_id: initial.templateId, format: "png", scale: 1 },
  });
  assert.equal(rr.status(), 200);
  const result = await rr.json();
  assert.equal(result.status, "done");
  try {
    const image = await api.get(result.image_url);
    assert.equal(image.status(), 200);
    await pixel(await image.body(), 70, 50, [50, 100, 160]);
  } finally {
    await api.delete("/api/renders/" + result.uid);
  }
  console.log(
    "✓ Legacy geometry: dashboard thumbnail, editor PNG and independent server render agree at native scale.",
  );
  const other = await context.newPage();
  await editor(other, id);
  await rename(page, name + " first");
  await save(page, id);
  await page.locator(".sl-save:not(.is-dirty)").waitFor();
  await rename(other, name + " other");
  await save(other, id, 409);
  await other.getByRole("button", { name: "Save as copy" }).waitFor();
  assert.equal((await row(id)).name, name + " first");
  const copying = other.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/templates/" + id + "/duplicate",
  );
  await other.getByRole("button", { name: "Save as copy" }).click();
  const cr = await copying;
  assert.equal(cr.status(), 201);
  const copy = await cr.json();
  ids.add(copy.id);
  await other.waitForURL("**/editor/" + copy.id);
  await other.locator(".sl-artboard:visible").waitFor();
  const fork = await row(copy.id);
  assert.equal(fork.name, name + " other (Copy)");
  assert.equal(fork.fields[0].name, "swatch");
  assert.equal((await row(id)).name, name + " first");
  await other.close();
  const competing = ["one", "two"].map((key) => ({
    expectedVersion: fork.version,
    designJson: { ...design, objects: [{ ...design.objects[0], name: key }] },
  }));
  const race = await Promise.all(
    competing.map((data) => api.put("/api/templates/" + copy.id, { data })),
  );
  assert.deepEqual(race.map((r) => r.status()).sort(), [200, 409]);
  const winner = await row(copy.id);
  assert.equal(winner.version, fork.version + 1);
  assert.equal(winner.fields.length, 1);
  assert.equal(winner.fields[0].name, winner.designJson.objects[0].name);
  const invalid = await api.put("/api/templates/" + copy.id, {
    data: {
      designJson: {
        objects: [{ ...design.objects[0], name: "x".repeat(256) }],
      },
    },
  });
  assert.equal(invalid.status(), 400);
  assert.equal((await row(copy.id)).version, winner.version);
  assert.equal((await row(copy.id)).fields[0].name, winner.fields[0].name);

  console.log(
    "✓ Stale tab gets 409 and can save a separate editable copy, including its API fields.",
  );
  // Fail a normal network save once. The user must still have the edit and be
  // able to retry without rebuilding the canvas.
  const url = "**/api/templates/" + id;
  await page.route(url, (rt) =>
    rt.request().method() === "PUT"
      ? rt.fulfill({ status: 503, json: { error: "Temporary save failure" } })
      : rt.continue(),
  );
  await rename(page, name + " retry");
  await save(page, id, 503);
  await page.getByRole("button", { name: "Retry save" }).waitFor();
  assert.equal((await row(id)).name, name + " first");
  await page.unroute(url);
  await page.getByRole("button", { name: "Retry save" }).click();
  await page.locator(".sl-save:not(.is-dirty)").waitFor();
  assert.equal((await row(id)).name, name + " retry");
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let started;
  const sent = new Promise((r) => {
    started = r;
  });
  await page.route(url, async (rt) => {
    if (rt.request().method() === "PUT") {
      started();
      await gate;
    }
    await rt.continue();
  });
  await rename(page, name + " pending");
  await page.locator(".sl-save").click();
  await sent;
  try {
    await rename(page, name + " newer");
  } finally {
    release();
  }
  await page
    .getByRole("button", { name: "Save changes", exact: true })
    .waitFor();
  await page.unroute(url);
  assert.equal((await row(id)).name, name + " pending");
  await save(page, id);
  assert.equal((await row(id)).name, name + " newer");
  console.log(
    "✓ Offline retry and edits made during a slow save preserve the current working copy.",
  );
  await page
    .getByRole("button", { name: "Back to Templates dashboard" })
    .click();
  await page
    .getByRole("heading", { name: name + " newer", exact: true })
    .waitFor();
  assert.equal(
    (
      await api.put("/api/templates/" + id, {
        data: { name: name + " remote" },
      })
    ).status(),
    200,
  );
  await page
    .getByRole("heading", { name: name + " newer", exact: true })
    .click();
  await page.locator(".sl-artboard:visible").waitFor();
  assert.equal(
    await page.locator(".sl-document").innerText(),
    name + " remote",
  );
  const stored = await row(id);
  let writes = 0;
  await page.route(url, async (rt) => {
    if (rt.request().method() === "GET")
      return rt.fulfill({
        status: 200,
        json: {
          ...stored,
          designJson: {
            objects: [
              { type: "Image", src: "/storage/unavailable-" + id + ".png" },
            ],
          },
        },
      });
    writes++;
    await rt.continue();
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Could not open the artwork" })
    .waitFor();
  assert.equal(
    await page.locator(".sl-editor").evaluate((el) => el.inert),
    true,
  );
  await page.keyboard.press("Control+s");
  assert.equal(writes, 0);
  await page.unroute(url);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.locator(".sl-artboard:visible").waitFor();
  assert.equal((await row(id)).version, stored.version);
  // Exercise background-only documents and failed history restores with a real
  // uploaded PNG. The request stub acts as offline storage *only in this tab*.
  const bgBytes = await sharp({
    create: { width: 256, height: 192, channels: 3, background: "#3c6699" },
  })
    .png()
    .toBuffer();
  const up = await api.post("/api/upload", {
    multipart: {
      file: {
        name: "qa-background.png",
        mimeType: "image/png",
        buffer: bgBytes,
      },
    },
  });
  assert.equal(up.status(), 201);
  const src = (await up.json()).url;
  const bg = {
    objects: [],
    backgroundImage: {
      type: "Image",
      src,
      left: 0,
      top: 0,
      width: 256,
      height: 192,
    },
  };
  assert.equal(
    (
      await api.put("/api/templates/" + copy.id, {
        data: { designJson: bg, name: "Background QA" },
      })
    ).status(),
    200,
  );
  let offline = false;
  const imgURL = new URL(src, baseURL).href;
  await page.route(imgURL, (r) =>
    offline
      ? r.fulfill({ status: 404, body: "" })
      : r.fulfill({
          contentType: "image/png",
          headers: { "cache-control": "no-store" },
          body: bgBytes,
        }),
  );
  await editor(page, copy.id);
  const b = (n) => page.getByRole("button", { name: n, exact: true });
  const undo = "Undo (Ctrl/⌘ Z)",
    redo = "Redo (Ctrl/⌘ Shift Z)";
  await rename(page, "Changed working copy");
  const failedStep = async (button, expected) => {
    offline = true;
    const missing = page.waitForResponse(
      (r) => r.url() === imgURL && r.status() === 404,
    );
    await b(button).click();
    await missing;
    await page
      .getByText("Could not restore that edit. Your current artwork was kept.")
      .first()
      .waitFor();
    await page.locator(".sl-editor:not([inert])").waitFor();
    assert.equal(await page.locator(".sl-document").innerText(), expected);
    offline = false;
  };
  await failedStep(undo, "Changed working copy");
  await b(undo).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".sl-document")?.textContent === "Background QA",
  );
  await failedStep(redo, "Background QA");
  await b(redo).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".sl-document")?.textContent ===
      "Changed working copy",
  );
  await b("Export").click();
  await b("PNG").click();
  await b("1×").click();
  const bgDl = page.waitForEvent("download");
  await b("Export PNG").click();
  await pixel(
    await readFile(await (await bgDl).path()),
    40,
    30,
    [60, 102, 153],
  );
  await save(page, copy.id);
  const kept = await row(copy.id);
  assert.equal(kept.designJson.backgroundImage.src, src);
  assert.deepEqual(kept.designJson.objects, []);
  const bgRender = await api.post("/api/render", {
    data: { template_id: kept.templateId, format: "png", scale: 1 },
  });
  const bgJob = await bgRender.json();
  try {
    assert.equal(bgJob.status, "done", bgJob.error);
    await pixel(
      await (await api.get(bgJob.image_url)).body(),
      40,
      30,
      [60, 102, 153],
    );
  } finally {
    if (bgJob.uid) await api.delete("/api/renders/" + bgJob.uid);
  }
  await page.unroute(imgURL);
  console.log(
    "✓ Failed undo and redo leave artwork intact. Background-only designs survive save, reopen and both PNG renderers.",
  );
  await page.route("**/api/templates/" + copy.id, (rt) =>
    rt.request().method() === "GET"
      ? rt.fulfill({
          json: {
            ...kept,
            width: 8192,
            height: 8192,
            designJson: { background: "#ffffff", objects: [] },
          },
        })
      : rt.continue(),
  );
  await editor(page, copy.id);
  const sizes = await page
    .locator(".sl-artboard canvas")
    .evaluateAll((nodes) => nodes.map((n) => [n.width, n.height]));
  assert(
    sizes.length >= 2 &&
      sizes.every(
        ([w, h]) =>
          w > 0 && h > 0 && w * h <= 12000000 && Math.max(w, h) <= 8192,
      ),
  );
  await b("Export").click();
  await b("PNG").click();
  await b("1×").click();
  assert(await b("Export PNG").isDisabled());
  await b("SVG").click();
  assert(!(await b("Export SVG").isDisabled()));
  console.log(
    "✓ Oversize raster export is blocked before allocation; the artboard remains editable and SVG stays available.",
  );
  assert.deepEqual(failures, []);
  console.log(
    "✓ Reopen reads fresh data. Missing artwork cannot overwrite a saved design, and retry recovers it.",
  );
} finally {
  try {
    for (const id of ids) await api.delete("/api/templates/" + id);
  } finally {
    await browser.close();
  }
}
