/**
 * Comprehensive functional tests for all pure/testable logic.
 * Run: npx tsx tests/unit/test-all.ts
 */

import { applyModifications, extractFields } from "../../src/lib/render/apply-modifications";
import { generateId, generateToken, formatDate, formatRelativeTime, formatDuration, truncate } from "../../src/lib/utils";
import { buildTimeline, collectVideoLayers, sourceTimeForFrame } from "../../src/lib/video/timeline";
import { walkDesignObjects } from "../../src/lib/design/walk";
import { isImage, isShape, isText } from "../../src/lib/design/predicates";
import { resolveOutput } from "../../src/lib/render/create-job";
import { storageFilePath } from "../../src/lib/storage";
import { isUrlSafe } from "../../src/lib/ssrf";
import { selfStoragePath } from "../../src/lib/render/inline-images";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function assertEqual(actual: any, expected: any, label: string) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// =============================================================
// Test Design JSON (mimics the seed template)
// =============================================================
const testDesign = {
  version: "5.3.0",
  objects: [
    {
      type: "rect",
      left: 0, top: 0, width: 1080, height: 1350,
      fill: "#1a1a2e",
      name: "background_rect",
      dynamic: false,
    },
    {
      type: "textbox",
      left: 60, top: 950, width: 960,
      fontSize: 56, fontFamily: "Arial", fontWeight: "bold",
      fill: "#ffffff", text: "AASTHA ENTERPRISE",
      textAlign: "center",
      name: "dealer_name", dynamic: true,
    },
    {
      type: "textbox",
      left: 60, top: 1030, width: 960,
      fontSize: 32, fontFamily: "Arial",
      fill: "#e0a13a", text: "AHMEDABAD",
      textAlign: "center",
      name: "city", dynamic: true,
    },
    {
      type: "image",
      left: 100, top: 100, width: 400, height: 300,
      src: "https://original.com/photo.jpg",
      name: "creative", dynamic: true,
    },
    {
      type: "circle",
      left: 500, top: 500, radius: 50,
      fill: "#ff0000",
      name: "dot", dynamic: true,
    },
    {
      type: "textbox",
      left: 60, top: 1100, width: 960,
      fontSize: 24, fontFamily: "Arial",
      fill: "#94a3b8", text: "+91 98765 43210",
      textAlign: "center",
      name: "phone", dynamic: true,
    },
  ],
  background: "#1a1a2e",
};


console.log("================================================================");
console.log("  CANOLITE — UNIT TESTS");
console.log("================================================================\n");

// =============================================================
// 1. applyModifications — Core render logic
// =============================================================
console.log("1. applyModifications\n");

// 1.1 Empty modifications
{
  const { modifiedJson, warnings } = applyModifications(testDesign, []);
  assertEqual(warnings.length, 0, "Empty mods → no warnings");
  assertEqual(modifiedJson.objects[1].text, "AASTHA ENTERPRISE", "Empty mods → text unchanged");
}

// 1.2 Text swap
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "dealer_name", text: "NEW DEALER" },
  ]);
  assertEqual(modifiedJson.objects[1].text, "NEW DEALER", "Text swap works");
  assertEqual(warnings.length, 0, "Text swap → no warnings");
}

// 1.3 Multiple text swaps
{
  const { modifiedJson } = applyModifications(testDesign, [
    { name: "dealer_name", text: "DEALER X" },
    { name: "city", text: "MUMBAI" },
    { name: "phone", text: "+91 11111 22222" },
  ]);
  assertEqual(modifiedJson.objects[1].text, "DEALER X", "Multi swap: dealer_name");
  assertEqual(modifiedJson.objects[2].text, "MUMBAI", "Multi swap: city");
  assertEqual(modifiedJson.objects[5].text, "+91 11111 22222", "Multi swap: phone");
}

// 1.4 Unknown field name → warn + ignore
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "nonexistent_field", text: "test" },
  ]);
  assert(warnings.length === 1, "Unknown field → 1 warning");
  assert(warnings[0].includes("nonexistent_field"), "Warning mentions the field name");
  assertEqual(modifiedJson.objects[1].text, "AASTHA ENTERPRISE", "Unknown field → text unchanged");
}

// 1.5 Missing name on modification → warn
{
  const { warnings } = applyModifications(testDesign, [
    { name: "", text: "test" },
  ]);
  // Empty name won't match any object
  assert(warnings.length >= 1, "Empty name → warning");
}

// 1.6 Blocked position fields → warn + ignore
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "dealer_name", text: "TEST", left: 999, top: 999 } as any,
  ]);
  assertEqual(modifiedJson.objects[1].text, "TEST", "Text applied despite blocked fields");
  assertEqual(modifiedJson.objects[1].left, 60, "left is NOT changed (blocked)");
  assertEqual(modifiedJson.objects[1].top, 950, "top is NOT changed (blocked)");
  assert(warnings.length >= 2, "Blocked fields produce warnings");
}

// 1.7 Width is blocked
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "dealer_name", width: 500 } as any,
  ]);
  assertEqual(modifiedJson.objects[1].width, 960, "width is NOT changed (blocked)");
  assert(warnings.some(w => w.includes("width")), "Width produces a warning");
}

// 1.8 Text style overrides (allowed)
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    {
      name: "dealer_name",
      text: "STYLED",
      fontSize: 72,
      fontWeight: "900",
      fill: "#ff0000",
      textAlign: "left",
      lineHeight: 1.5,
      opacity: 0.8,
    },
  ]);
  assertEqual(modifiedJson.objects[1].text, "STYLED", "Text set");
  assertEqual(modifiedJson.objects[1].fontSize, 72, "fontSize override applied");
  assertEqual(modifiedJson.objects[1].fontWeight, "900", "fontWeight override applied");
  assertEqual(modifiedJson.objects[1].fill, "#ff0000", "fill override applied");
  assertEqual(modifiedJson.objects[1].textAlign, "left", "textAlign override applied");
  assertEqual(modifiedJson.objects[1].lineHeight, 1.5, "lineHeight override applied");
  assertEqual(modifiedJson.objects[1].opacity, 0.8, "opacity override applied");
  assertEqual(warnings.length, 0, "All valid overrides → no warnings");
}

// 1.9 Font family validation — known font
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "dealer_name", fontFamily: "Inter" },
  ]);
  assertEqual(modifiedJson.objects[1].fontFamily, "Inter", "Known font applied");
  assertEqual(warnings.length, 0, "Known font → no warnings");
}

// 1.10 Font family validation — unknown font → keep original + warn
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "dealer_name", fontFamily: "UnknownFont123" },
  ]);
  assertEqual(modifiedJson.objects[1].fontFamily, "Arial", "Unknown font → kept original");
  assert(warnings.length === 1, "Unknown font → 1 warning");
  assert(warnings[0].includes("UnknownFont123"), "Warning mentions bad font");
}

// 1.11 Image URL swap
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "creative", image_url: "https://new.com/photo2.jpg" },
  ]);
  assertEqual(modifiedJson.objects[3].src, "https://new.com/photo2.jpg", "Image src swapped");
  assertEqual(warnings.length, 0, "Image swap → no warnings");
}

// 1.12 Image — disallowed property → warn
{
  const { warnings } = applyModifications(testDesign, [
    { name: "creative", image_url: "https://x.com/img.png", fill: "#000" } as any,
  ]);
  assert(warnings.some(w => w.includes("fill") && w.includes("image allowlist")), "fill on image → warning");
}

// 1.13 Shape — fill override
{
  const { modifiedJson, warnings } = applyModifications(testDesign, [
    { name: "dot", fill: "#00ff00", opacity: 0.5 },
  ]);
  assertEqual(modifiedJson.objects[4].fill, "#00ff00", "Shape fill changed");
  assertEqual(modifiedJson.objects[4].opacity, 0.5, "Shape opacity changed");
}

// 1.14 Shape — unsupported property → warn
{
  const { warnings } = applyModifications(testDesign, [
    { name: "dot", text: "hello" } as any,
  ]);
  assert(warnings.length >= 1, "text on shape → warning");
}

// 1.15 Design JSON is deep-cloned (no mutation)
{
  const originalText = testDesign.objects[1].text;
  const { modifiedJson } = applyModifications(testDesign, [
    { name: "dealer_name", text: "MUTATED" },
  ]);
  assertEqual(testDesign.objects[1].text, originalText, "Original design NOT mutated");
  assertEqual(modifiedJson.objects[1].text, "MUTATED", "Clone IS mutated");
}

// 1.16 Null/undefined modifications
{
  const { warnings } = applyModifications(testDesign, null as any);
  assertEqual(warnings.length, 0, "null modifications → no crash");
}

// 1.17 Modification with name but no modification → keep default
{
  const { modifiedJson } = applyModifications(testDesign, [
    { name: "dealer_name" },
  ]);
  assertEqual(modifiedJson.objects[1].text, "AASTHA ENTERPRISE", "No text prop → keeps default");
}


// =============================================================
// 2. extractFields
// =============================================================
console.log("\n2. extractFields\n");

{
  const fields = extractFields(testDesign);
  // background_rect has dynamic: false, so 5 fields
  assert(fields.length === 5, `extractFields finds 5 dynamic fields (got ${fields.length})`);
  assertEqual(fields[0].name, "dealer_name", "First field is dealer_name");
  assertEqual(fields[0].type, "text", "dealer_name is text type");
  assertEqual(fields[0].defaultValue, "AASTHA ENTERPRISE", "dealer_name default value");
  assertEqual(fields[3].name, "dot", "dot field extracted");
  assertEqual(fields[3].type, "shape", "dot is shape type");
}

// extractFields with null design
{
  const fields = extractFields(null);
  assertEqual(fields.length, 0, "Null design → empty fields");
}

// extractFields with empty objects
{
  const fields = extractFields({ objects: [] });
  assertEqual(fields.length, 0, "Empty objects → empty fields");
}

// extractFields respects dynamic: false
{
  const fields = extractFields(testDesign);
  assert(!fields.find(f => f.name === "background_rect"), "background_rect (dynamic:false) excluded");
}


// =============================================================
// 3. Utils
// =============================================================
console.log("\n3. Utils\n");

// generateId
{
  const id1 = generateId("tmpl");
  assert(id1.startsWith("tmpl_"), `generateId with prefix: ${id1}`);
  assert(id1.length > 10, "generateId has enough length");

  const id2 = generateId("tmpl");
  assert(id1 !== id2, "generateId produces unique values");

  const id3 = generateId();
  assert(!id3.includes("_"), "generateId without prefix: no underscore");
}

// generateToken
{
  const t1 = generateToken(32);
  assert(t1.length === 32, `generateToken(32) has length 32`);
  const t2 = generateToken(32);
  assert(t1 !== t2, "generateToken produces unique values");
  assert(/^[A-Za-z0-9]+$/.test(t1), "generateToken is alphanumeric");
}

// formatDate
{
  const d = formatDate("2024-06-15T10:30:00Z");
  assert(typeof d === "string" && d.length > 0, `formatDate: ${d}`);
}

// formatDuration
{
  assertEqual(formatDuration(500), "500ms", "formatDuration < 1s");
  assertEqual(formatDuration(1500), "1.5s", "formatDuration >= 1s");
  assertEqual(formatDuration(0), "0ms", "formatDuration 0");
}

// truncate
{
  assertEqual(truncate("hello", 10), "hello", "truncate: short string unchanged");
  assertEqual(truncate("hello world this is long", 10), "hello worl…", "truncate: long string cut");
}

// formatRelativeTime
{
  const now = new Date();
  const result = formatRelativeTime(now.toISOString());
  assertEqual(result, "just now", "formatRelativeTime: now");

  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const result2 = formatRelativeTime(fiveMinAgo.toISOString());
  assertEqual(result2, "5m ago", "formatRelativeTime: 5m ago");
}


// =============================================================
// 4. Validation Schemas
// =============================================================
console.log("\n4. Validation Schemas\n");

import { renderRequestSchema, batchRequestSchema } from "../../src/lib/validation";

// Valid render request
{
  const result = renderRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    modifications: [{ name: "headline", text: "Hello" }],
    format: "png",
    quality: 90,
    scale: 2,
  });
  assert(result.success, "Valid render request passes");
}

// Missing template_id
{
  const result = renderRequestSchema.safeParse({
    modifications: [{ name: "headline", text: "Hello" }],
  });
  assert(!result.success, "Missing template_id fails");
}

// Invalid format
{
  const result = renderRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    format: "bmp",
  });
  assert(!result.success, "Invalid format 'bmp' fails");
}

// Quality out of range
{
  const result = renderRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    quality: 200,
  });
  assert(!result.success, "Quality 200 fails");
}

// Scale out of range
{
  const result = renderRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    scale: 5,
  });
  assert(!result.success, "Scale 5 fails");
}

// Valid batch
{
  const result = batchRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    items: [
      { modifications: [{ name: "title", text: "A" }] },
      { modifications: [{ name: "title", text: "B" }] },
    ],
    format: "jpg",
    quality: 85,
  });
  assert(result.success, "Valid batch request passes");
}

// Empty items
{
  const result = batchRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    items: [],
  });
  assert(!result.success, "Empty items fails");
}

// Modification with invalid image_url
{
  const result = renderRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    modifications: [{ name: "photo", image_url: "not-a-url" }],
  });
  assert(!result.success, "Invalid image_url fails");
}

// Valid modification with all style overrides
{
  const result = renderRequestSchema.safeParse({
    template_id: "tmpl_abc123",
    modifications: [{
      name: "headline",
      text: "Hello",
      fontFamily: "Arial",
      fontSize: 48,
      fontWeight: "bold",
      fill: "#ff0000",
      textAlign: "center",
      lineHeight: 1.2,
      opacity: 0.9,
    }],
  });
  assert(result.success, "Full style override passes validation");
}


// =============================================================
// 5. API Key generation
// =============================================================
console.log("\n5. API Key generation\n");

import { generateApiKey, verifyApiKey, extractPrefix } from "../../src/lib/api-keys";

// Async: verifyApiKey now hands bcrypt to the thread pool instead of blocking.
async function apiKeyTests() {
  const { fullKey, prefix, hash } = generateApiKey();
  assert(fullKey.startsWith("sk_live_"), `Key starts with sk_live_: ${fullKey.substring(0, 20)}...`);
  assert(fullKey.length > 30, "Key has sufficient length");
  assert(prefix.length === 12, `Prefix is 12 chars: ${prefix}`);
  assert(prefix === fullKey.substring(0, 12), "Prefix matches key start");
  assert(hash.startsWith("$2"), "Hash is bcrypt");
  assert(await verifyApiKey(fullKey, hash), "Key verifies against its hash");
  assert(
    !(await verifyApiKey("sk_live_wrong_key_here_bad", hash)),
    "Wrong key does NOT verify"
  );
  assertEqual(extractPrefix(fullKey), prefix, "extractPrefix matches");
}

// Multiple keys are unique
{
  const k1 = generateApiKey();
  const k2 = generateApiKey();
  assert(k1.fullKey !== k2.fullKey, "Two generated keys are different");
  assert(k1.hash !== k2.hash, "Two hashes are different");
}


// =============================================================
// 6. CORS headers
// =============================================================
console.log("\n6. CORS headers\n");

import { corsHeaders } from "../../src/lib/cors";

{
  const headers = corsHeaders();
  assert(headers["Access-Control-Allow-Origin"] === "*", "CORS origin is *");
  assert(headers["Access-Control-Allow-Methods"].includes("POST"), "CORS allows POST");
  assert(headers["Access-Control-Allow-Methods"].includes("GET"), "CORS allows GET");
  assert(headers["Access-Control-Allow-Headers"].includes("Authorization"), "CORS allows Authorization header");
}


// =============================================================
// 7. Schema structure checks
// =============================================================
console.log("\n7. Database schema structure\n");

import * as schema from "../../src/db/schema";

assert(!!schema.users, "users table exists");
assert(!!schema.accounts, "accounts table exists");
assert(!!schema.sessions, "sessions table exists");
assert(!!schema.projects, "projects table exists");
assert(!!schema.templates, "templates table exists");
assert(!!schema.templateFields, "templateFields table exists");
assert(!!schema.apiKeys, "apiKeys table exists");
assert(!!schema.renderJobs, "renderJobs table exists");
assert(!!schema.assets, "assets table exists");
assert(!!schema.templateVersions, "templateVersions table exists");


// =============================================================
// 8. Render fonts
// =============================================================
console.log("\n8. Render fonts\n");

import { promises as fsp } from "fs";
import pathMod from "path";
import { inlineFontSources } from "../../src/lib/render/inline-fonts";
import { buildFontHead } from "../../src/lib/render/render-image";

async function renderFontTests() {
  // The render page is created with page.setContent(), so it has an opaque
  // "null" origin — and CSS font fetches are always CORS-mode. A font left as
  // a /storage URL is therefore blocked and silently falls back to a generic
  // face. The contract: every custom font reaching the render page carries its
  // bytes inline.
  const key = `fonts/test-${Date.now()}.ttf`;
  const bytes = Buffer.from("OTTO-not-a-real-font");
  const file = storageFilePath(key);
  await fsp.mkdir(pathMod.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes);

  try {
    const [font] = await inlineFontSources([
      { family: "My Custom", url: `/storage/${key}` },
    ]);
    assert(font.url.startsWith("data:font/ttf;base64,"), "stored font URL is inlined as a data: URL");
    assert(
      Buffer.from(font.url.split(",")[1], "base64").equals(bytes),
      "inlined font carries the stored bytes"
    );
    assertEqual(font.family, "My Custom", "inlining preserves the family name");
  } finally {
    await fsp.unlink(file).catch(() => {});
  }

  const already = "data:font/woff2;base64,AAAA";
  const [passthrough] = await inlineFontSources([{ family: "X", url: already }]);
  assertEqual(passthrough.url, already, "an already-inlined font is left untouched");

  const [missing] = await inlineFontSources([
    { family: "Gone", url: "/storage/fonts/does-not-exist.ttf" },
  ]);
  assertEqual(
    missing.url,
    "/storage/fonts/does-not-exist.ttf",
    "an unresolvable font keeps its URL rather than failing the render"
  );

  const head = buildFontHead(["My Custom", "Arial"], [
    { family: "My Custom", url: "data:font/ttf;base64,AAAA" },
  ]);
  assert(head.includes(`@font-face`), "custom family used in the design gets an @font-face");
  assert(head.includes(`font-family:'My Custom'`), "@font-face declares the custom family");
  assert(head.includes("data:font/ttf;base64,AAAA"), "@font-face src is the inlined URL");
  assert(!head.includes("Arial"), "a family with no custom font gets no @font-face");
}

// =============================================================
// 9. Template thumbnails
// =============================================================
console.log("\n9. Template thumbnails\n");

import {
  thumbnailKey,
  thumbnailScale,
  THUMBNAIL_MAX_EDGE,
} from "../../src/lib/render/thumbnail";

{
  // The key carries updatedAt so editing a template produces a new URL —
  // a stale preview can never survive in the browser cache.
  assertEqual(
    thumbnailKey("a1b2c3", new Date(1700000000000)),
    "thumbnails/a1b2c3-1700000000000.webp",
    "thumbnail key is thumbnails/<id>-<epochMs>.webp"
  );

  assert(
    thumbnailKey("a1b2c3", new Date(1700000000000)) !==
      thumbnailKey("a1b2c3", new Date(1700000000001)),
    "key changes when updatedAt changes"
  );

  // Longest edge lands exactly on the target, whatever the orientation.
  assertEqual(
    Math.round(1080 * thumbnailScale(1080, 1080)),
    THUMBNAIL_MAX_EDGE,
    "square 1080x1080 scales to a 400px longest edge"
  );
  assertEqual(
    Math.round(2752 * thumbnailScale(1536, 2752)),
    THUMBNAIL_MAX_EDGE,
    "portrait 1536x2752 scales to a 400px longest edge"
  );
  assertEqual(
    Math.round(1920 * thumbnailScale(1920, 1080)),
    THUMBNAIL_MAX_EDGE,
    "landscape 1920x1080 scales to a 400px longest edge"
  );

  assertEqual(
    thumbnailScale(200, 200),
    1,
    "a template smaller than the target is never upscaled"
  );
}

// =============================================================
// 10. Video timeline and modifications
// =============================================================
console.log("\n10. Video timeline and modifications\n");

{
  const design = {
    objects: [
      {
        type: "image",
        id: "vid1",
        name: "hero_video",
        dynamic: true,
        mediaType: "video",
        src: "/storage/uploads/poster.jpg",
        videoSrc: "/storage/uploads/clip.mp4",
        videoDuration: 12,
        trimStart: 2,
        trimEnd: 8,
        startAt: 1,
        loop: false,
        muted: false,
        volume: 0.75,
        playbackRate: 2,
        fit: "cover",
        hasAudio: true,
        width: 400,
        height: 300,
        scaleX: 0.5,
        scaleY: 2,
      },
    ],
  };

  const layers = collectVideoLayers(design);
  assertEqual(layers.length, 1, "collectVideoLayers finds Fabric image video layers");
  assertEqual(layers[0].boxW, 200, "video layer boxW uses width × scaleX");
  assertEqual(layers[0].boxH, 600, "video layer boxH uses height × scaleY");

  const timeline = buildTimeline(design, { fps: 30 });
  assertEqual(timeline.durationSec, 5, "timeline minimum duration is 5s when layer ends earlier");
  assertEqual(timeline.frameCount, 150, "frameCount = ceil(duration × fps)");
  assertEqual(buildTimeline(design, { fps: 24, durationSec: 10 }).durationSec, 10, "explicit video duration wins");

  assertEqual(sourceTimeForFrame(layers[0], 0, 30), null, "sourceTime null before startAt");
  assertEqual(sourceTimeForFrame(layers[0], 30, 30), 2, "sourceTime starts at trimStart on startAt frame");
  assertEqual(sourceTimeForFrame(layers[0], 60, 30), 4, "sourceTime honors playbackRate");
  assertEqual(sourceTimeForFrame(layers[0], 121, 30), null, "sourceTime null after non-looping layer ends");

  const looping = { ...layers[0], loop: true };
  assertEqual(sourceTimeForFrame(looping, 150, 30), 4, "sourceTime wraps when loop is true");

  // Regression: Fabric v6 SERIALIZES type as "Image" (capitalised) even though a
  // live object reports "image". Every fixture above uses the live casing, so a
  // case-sensitive check passed this whole suite while collecting zero layers
  // from real saved designs — the "Template contains no video layers" bug.
  const savedDesign = { objects: [{ ...design.objects[0], type: "Image" }] };
  assertEqual(
    collectVideoLayers(savedDesign).length,
    1,
    'collectVideoLayers finds video layers in saved designs (type: "Image")'
  );
  assertEqual(
    collectVideoLayers({
      objects: [{ type: "Rect", mediaType: "video", videoSrc: "/x.mp4" }],
    }).length,
    0,
    "collectVideoLayers ignores non-image objects regardless of casing"
  );

  const { modifiedJson, warnings } = applyModifications(design, [
    {
      name: "hero_video",
      video_url: "https://cdn.example.com/new.mp4",
      trim_end: 99,
      start_at: 3,
      muted: true,
      text: "ignored",
    } as any,
  ]);
  assertEqual(modifiedJson.objects[0].videoSrc, "https://cdn.example.com/new.mp4", "video_url swaps videoSrc");
  assertEqual(modifiedJson.objects[0].src, "/storage/uploads/poster.jpg", "video_url leaves poster src unchanged");
  assertEqual(modifiedJson.objects[0].trimEnd, 12, "trim_end clamps to known videoDuration");
  assertEqual(modifiedJson.objects[0].startAt, 3, "start_at maps to startAt");
  assertEqual(modifiedJson.objects[0].muted, true, "muted override applies");
  assert(warnings.some((w) => w.includes("text") && w.includes("video allowlist")), "text on video warns and is ignored");

  const fields = extractFields(design);
  assertEqual(fields[0].type, "video", "extractFields emits video type");
  assertEqual(fields[0].defaultValue, "/storage/uploads/clip.mp4", "video field default is videoSrc");
}


// =============================================================
// 11. Shared design helpers and pure safety checks
// =============================================================
console.log("\n11. Shared design helpers and pure safety checks\n");

{
  const nested = {
    objects: [
      { type: "textbox", name: "a" },
      { type: "group", objects: [{ type: "image", name: "b" }, { type: "rect", name: "c" }] },
    ],
  };
  const seen: string[] = [];
  walkDesignObjects(nested, ({ object, path }) => seen.push(`${path}:${object.name || object.type}`));
  assertEqual(seen, ["0:a", "1:group", "1.0:b", "1.1:c"], "walkDesignObjects visits nested Fabric objects in order");
  assert(isText(nested.objects[0]), "isText recognises textbox");
  assert(isImage((nested.objects[1] as any).objects[0]), "isImage recognises image");
  assert(isShape((nested.objects[1] as any).objects[1]), "isShape recognises rect");

  const resolved = resolveOutput(
    { outputDefaults: { format: "jpg", quality: 80, scale: 2 } },
    { quality: 70 },
    { defaultFormat: "webp", defaultQuality: 60, defaultScale: 1 }
  );
  assertEqual(resolved, { format: "jpg", quality: 70, scale: 2 }, "resolveOutput priority is request → template → global → default");

  let traversalBlocked = false;
  try {
    storageFilePath("../secret.txt");
  } catch {
    traversalBlocked = true;
  }
  assert(traversalBlocked, "storageFilePath blocks path traversal");
}

async function ssrfTests() {
  assertEqual(await isUrlSafe("not-a-url"), false, "SSRF guard rejects invalid URLs");
  assertEqual(await isUrlSafe("file:///etc/passwd"), false, "SSRF guard rejects non-http schemes");
  assertEqual(await isUrlSafe("http://127.0.0.1:3000"), false, "SSRF guard rejects loopback IPv4");
  assertEqual(await isUrlSafe("http://[::1]/"), false, "SSRF guard rejects loopback IPv6");

  // Fabric saves an image's src already absolutized by the browser. Those
  // same-origin /storage URLs must be normalised back to root-relative, or the
  // renderer treats them as external and the SSRF guard (correctly) blocks the
  // loopback fetch — which is what broke MP4 export on the video poster.
  assertEqual(
    selfStoragePath("http://localhost:3000/storage/uploads/a/b.jpg"),
    "/storage/uploads/a/b.jpg",
    "self storage URL on localhost is normalised to a relative path"
  );
  assertEqual(
    selfStoragePath("http://127.0.0.1:9999/storage/x.png"),
    "/storage/x.png",
    "self storage URL is normalised on any loopback port"
  );
  assertEqual(
    selfStoragePath("https://evil.example.com/storage/x.png"),
    null,
    "an off-origin /storage URL is NOT treated as our own"
  );
  assertEqual(
    selfStoragePath("http://localhost:3000/etc/passwd"),
    null,
    "a same-origin non-storage path is not normalised"
  );
  assertEqual(
    selfStoragePath("/storage/already/relative.jpg"),
    null,
    "an already-relative src needs no normalisation"
  );
}

// =============================================================
// RESULTS
// =============================================================
renderFontTests().then(apiKeyTests).then(ssrfTests).then(() => {
  console.log("\n================================================================");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("================================================================");

  if (failed > 0) {
    process.exit(1);
  }
});
