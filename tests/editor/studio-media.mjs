// End-to-end media acceptance check. Requires normal authentication, a disposable
// workspace and the same ffmpeg/ffprobe binaries a production video renderer uses.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import sharp from "sharp";
const require = createRequire(import.meta.url);
const email = process.env.CANOLITE_TEST_EMAIL,
  password = process.env.CANOLITE_TEST_PASSWORD;
if (!email || !password) throw Error("Set disposable test credentials.");
const dir = await mkdtemp(path.join(tmpdir(), "canolite-media-check-"));
const browser = await chromium.launch();
const ctx = await browser.newContext({
  baseURL: process.env.STUDIO_TEST_URL || "http://127.0.0.1:3000",
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage(),
  api = ctx.request;
let id, uid;
page.setDefaultTimeout(15000);
try {
  const ffmpeg = process.env.FFMPEG_PATH || require("ffmpeg-static"),
    ffprobe = process.env.FFPROBE_PATH || require("ffprobe-static").path;
  const file = path.join(dir, "sample.mp4");
  const gen = spawnSync(
    ffmpeg,
    [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=128x96:d=1:r=12",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      file,
    ],
    { timeout: 25000 },
  );
  assert.equal(gen.status, 0, "Could not generate the test clip.");
  assert.equal((await api.get("/api/templates")).status(), 401);
  assert.equal(
    (await api.post("/api/auth/login", { data: { email, password } })).status(),
    200,
  );
  const initial = await api.post("/api/templates", {
    data: {
      name: "Media QA " + randomUUID().slice(0, 8),
      width: 256,
      height: 192,
    },
  });
  assert.equal(initial.status(), 201);
  id = (await initial.json()).id;
  const family = "StudioQA_" + randomUUID().replaceAll("-", "").slice(0, 10);
  const font = await api.post("/api/upload", {
    multipart: {
      file: {
        name: family + ".woff2",
        mimeType: "font/woff2",
        buffer: await readFile("public/studio/fonts/dm-sans-latin.woff2"),
      },
    },
  });
  assert([200, 201].includes(font.status()));
  assert.equal(
    (
      await api.put("/api/templates/" + id, {
        data: {
          designJson: {
            objects: [
              {
                type: "Textbox",
                fontFamily: family,
                text: "Clip",
                left: 8,
                top: 8,
                fontSize: 10,
                width: 80,
              },
            ],
            background: "#ffffff",
          },
        },
      })
    ).status(),
    200,
  );
  let unlock;
  const gate = new Promise((r) => {
    unlock = r;
  });
  await page.route("**/api/fonts", async (rt) => {
    await gate;
    await rt.continue();
  });
  try {
    await page.goto("/editor/" + id);
    await page.locator(".sl-artboard:visible").waitFor();
  } finally {
    unlock();
  }
  await page.waitForFunction(
    (f) =>
      [...document.fonts].some((x) => x.family === f && x.status === "loaded"),
    family,
  );
  await page.unroute("**/api/fonts");
  console.log(
    "✓ Stored custom font loads even when the font list arrives after the artwork.",
  );
  const b = (n) => page.getByRole("button", { name: n, exact: true });
  await page
    .getByRole("navigation", { name: "Editor tools" })
    .getByRole("button", { name: "Uploads" })
    .click();
  const choose = page.waitForEvent("filechooser");
  await b("Upload a video").click();
  await (await choose).setFiles(file);
  await b("Play timeline").waitFor();
  await b("Play timeline").click();
  await b("Pause timeline").waitFor();
  await b("Stop timeline").click();
  const put = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      new URL(r.url()).pathname === "/api/templates/" + id,
  );
  await page.locator(".sl-save").click();
  assert.equal((await put).status(), 200);
  const stored = await (await api.get("/api/templates/" + id)).json();
  const video = stored.designJson.objects.find((o) => o.mediaType === "video");
  assert(stored.hasVideo && video);
  assert.match(video.videoSrc, /^\/storage\//);
  assert.match(video.src, /^\/storage\/.+poster\.jpg$/);
  await page.reload();
  await b("Play timeline").waitFor();
  for (const format of ["JPG", "WEBP", "SVG"]) {
    await b("Export").click();
    await b(format).click();
    if (format !== "SVG") await b("2×").click();
    const wait = page.waitForEvent("download");
    await b("Export " + format).click();
    const bytes = await readFile(await (await wait).path());
    if (format === "SVG") {
      const svg = bytes.toString();
      assert.match(svg, /<svg\b/);
      assert.match(svg, /width="256"/);
      assert.match(svg, /height="192"/);
      assert.match(svg, /href="data:image\/jpeg;base64,/);
    } else {
      const m = await sharp(bytes).metadata();
      assert.equal(m.format, format === "JPG" ? "jpeg" : "webp");
      assert.equal(m.width, 512);
      assert.equal(m.height, 384);
    }
    await page.getByRole("dialog").waitFor({ state: "detached" });
  }
  console.log(
    "✓ Real video upload, playback, save/reopen, 2× JPG/WebP and native-size SVG.",
  );
  await b("Export").click();
  await b("MP4").click();
  await b("1×").click();
  await b("24 fps").click();
  await page.getByLabel("Duration (seconds)").fill("1");
  const post = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/render",
  );
  await b("Export MP4").click();
  const job = await post;
  assert.equal(job.status(), 202);
  uid = (await job.json()).uid;
  await page.waitForURL("**/renders");
  async function done(jobUid) {
    const deadline = Date.now() + 75000;
    for (;;) {
      const r = await api.get("/api/renders/" + jobUid);
      assert.equal(r.status(), 200);
      const job = await r.json();
      if (job.status === "done" || job.status === "failed") return job;
      if (Date.now() >= deadline)
        throw Error("Timed out waiting for video: " + job.status);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  const finished = await done(uid);
  assert.equal(finished.status, "done", finished.error);
  const media = await api.get(finished.outputUrl || finished.imageUrl);
  assert.equal(media.status(), 200);
  const out = path.join(dir, "rendered.mp4");
  await writeFile(out, await media.body());
  const result = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration",
      "-of",
      "json",
      out,
    ],
    { encoding: "utf8", timeout: 12000 },
  );
  assert.equal(result.status, 0);
  const [track] = JSON.parse(result.stdout).streams;
  assert.equal(track.width, 256);
  assert.equal(track.height, 192);
  assert(Math.abs(Number(track.duration) - 1) < 0.12);
  async function checkGreen(filename) {
    const frame = spawnSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-ss",
        "0.5",
        "-i",
        filename,
        "-vf",
        "format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-threads",
        "1",
        "pipe:1",
      ],
      { timeout: 15000 },
    );
    assert.equal(frame.status, 0);
    const i = (120 * 256 + 150) * 3;
    const [r, g, b] = frame.stdout.subarray(i, i + 3);
    assert(
      r < 35 && g > 95 && g < 175 && b < 35,
      `Expected the video layer at (150,120); got ${r},${g},${b}`,
    );
  }
  await checkGreen(out);
  // A pre-Fabric-7 saved document may omit origins on every layer. Exercise
  // the worker directly as well: the UI's save serializes explicit origins.
  const snapshot = await (await api.get("/api/templates/" + id)).json();
  for (const layer of snapshot.designJson.objects) {
    delete layer.originX;
    delete layer.originY;
  }
  assert.equal(
    (
      await api.put("/api/templates/" + id, {
        data: {
          designJson: snapshot.designJson,
          expectedVersion: snapshot.version,
        },
      })
    ).status(),
    200,
  );
  const legacy = await api.post("/api/render", {
    data: {
      template_id: snapshot.templateId,
      format: "mp4",
      fps: 24,
      duration: 1,
      scale: 1,
    },
  });
  assert.equal(legacy.status(), 202);
  const legacyUid = (await legacy.json()).uid;
  try {
    const job = await done(legacyUid);
    assert.equal(job.status, "done", job.error);
    const r = await api.get(job.outputUrl);
    assert.equal(r.status(), 200);
    await writeFile(out, await r.body());
    await checkGreen(out);
  } finally {
    await api.delete("/api/renders/" + legacyUid);
  }
  console.log(
    "✓ MP4 exported through the real queue; ffprobe verified 256 × 192 and one second of playable video. Decoded pixels also verified the legacy clip position.",
  );
} finally {
  try {
    if (uid) await api.delete("/api/renders/" + uid);
    if (id) await api.delete("/api/templates/" + id);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}
