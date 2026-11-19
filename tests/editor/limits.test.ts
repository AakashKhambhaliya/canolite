import { test } from "node:test";
import assert from "node:assert/strict";
import {
  maxDisplayZoom,
  pushSnapshot,
  rasterExportIssue,
} from "../../src/lib/editor/artwork";
import { createArtworkVerifier } from "../../src/lib/design/loaded-artwork";
test("cap the output raster at the chosen scale without allocating it", () => {
  assert.equal(rasterExportIssue(1080, 1350, 4), null);
  assert(rasterExportIssue(8000, 8000, 1));
  assert(rasterExportIssue(5000, 32, 4));
  assert(rasterExportIssue(0, 128, 1));
});
test("bound live Retina backstores separately from logical artboard size", () => {
  for (const [w, h, dpr] of [
    [8192, 8192, 3],
    [16384, 80, 2],
    [900, 1400, 1],
  ]) {
    const z = maxDisplayZoom(w, h, dpr);
    assert(w * h * (z * dpr) ** 2 <= 12000000.01);
    assert(Math.max(w, h) * z * dpr <= 8192.01);
  }
});
test("history keeps the newest entry, truncates redo, and obeys both caps", () => {
  assert.deepEqual(pushSnapshot(["aaaaaaaa", "bbbbbbbb"], 0, "cc", 10), [
    "aaaaaaaa",
    "cc",
  ]);
  assert.deepEqual(pushSnapshot(["a", "b"], 1, "too big", 4), ["too big"]);
  assert.equal(pushSnapshot(Array(80).fill("x"), 79, "y").length, 80);
});
test("reject incomplete nested groups, backgrounds and clip paths, not empty documents", () => {
  const verify = createArtworkVerifier();
  verify({ objects: [] }, { getObjects: () => [] });
  assert.throws(() =>
    verify(
      { objects: [{ objects: [{}] }] },
      { getObjects: () => [{ getObjects: () => [] }] },
    ),
  );
  assert.throws(() => verify({ backgroundImage: {} }, {}));
  assert.throws(() => verify({ clipPath: {} }, {}));
});

test("field indexing rejects malformed layer lists without disallowing blank canvases", async () => {
  const { documentFields } = await import("../../src/lib/editor/design-fields");
  assert.deepEqual(documentFields(null), []);
  assert.deepEqual(documentFields({ objects: [], background: "#123456" }), []);
  assert.throws(() => documentFields({ objects: "not a layer list" }));
  assert.throws(() =>
    documentFields({ objects: [{ type: "Group", objects: [{}] }] }),
  );
});

test("render preparation includes first-party backgrounds and nested clip images", async () => {
  const { inlineExternalImages } =
    await import("../../src/lib/render/inline-images");
  const image = { type: "Image", src: "/storage/qa.png" };
  const design = {
    objects: [{ type: "Rect", clipPath: image }],
    backgroundImage: image,
  };
  const prepared = await inlineExternalImages(design);
  assert.equal(prepared.backgroundImage.crossOrigin, "anonymous");
  assert.equal(prepared.objects[0].clipPath.crossOrigin, "anonymous");
  assert.deepEqual(design.backgroundImage, {
    type: "Image",
    src: "/storage/qa.png",
  });
});
