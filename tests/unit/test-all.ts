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
import {
  crfToVideoQuality,
  estimateOutputBytes,
  normalizeFormat,
  projectDefaultsLayer,
  resolveOutputSettings,
  videoQualityToCrf,
} from "../../src/lib/output-settings";
import {
  buildRenderTimeStats,
  estimateBatchMs,
  estimateRenderMs,
  formatEta,
  formatRenderTime,
  remainingMs,
} from "../../src/lib/render-time";
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

  // The family name comes from an UPLOADED FILE'S NAME and the URL from that
  // asset's row, so both are attacker-influenced. Interpolated raw, a quote
  // ends the CSS string and `</style>` ends the element — injecting markup,
  // and therefore script, into the headless render page.
  // Everything between the <style> tags is the stylesheet text; the wrapper's
  // own tags are the only markup that may appear in the output.
  const styleBody = (head: string) =>
    head.replace(/^<style>/, "").replace(/<\/style>$/, "");
  // A CSS string ends at the first quote NOT preceded by a backslash.
  const unescapedQuotes = (css: string) =>
    (css.match(/(^|[^\\])'/g) || []).length;

  const hostile = `x'; } </style><script>fetch('http://169.254.169.254')</script><style>{`;
  const injected = buildFontHead([hostile], [
    { family: hostile, url: "data:font/ttf;base64,AAAA" },
  ]);
  assertEqual(
    (injected.match(/<\/?style>/g) || []).length,
    2,
    "a hostile font family cannot open or close a <style> element"
  );
  assert(
    !styleBody(injected).includes("<"),
    "no '<' survives into the stylesheet text, so no tag can be injected"
  );
  assertEqual(
    unescapedQuotes(styleBody(injected)),
    4,
    "only the four intended string delimiters are live quotes"
  );
  assert(
    styleBody(injected).endsWith("');font-display:block;}"),
    "the @font-face rule is still structurally intact"
  );

  const hostileUrl = buildFontHead(["Fine"], [
    { family: "Fine", url: `data:font/ttf;base64,AAAA'); } </style><script>x()</script>` },
  ]);
  assertEqual(
    (hostileUrl.match(/<\/?style>/g) || []).length,
    2,
    "a hostile font URL cannot break out of the rule either"
  );
  assertEqual(
    unescapedQuotes(styleBody(hostileUrl)),
    4,
    "a quote in the URL is escaped rather than closing the url() string"
  );
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
// 13. Login rate limiting
// =============================================================
console.log("\n13. Login rate limiting\n");

import {
  checkRateLimit,
  clearRateLimit,
  clientKey,
  recordFailure,
  __resetRateLimits,
} from "../../src/lib/rate-limit";

function rateLimitTests() {
  __resetRateLimits();
  const cfg = { limit: 3, windowMs: 60_000 };

  assert(checkRateLimit("a", cfg).allowed, "a fresh key is allowed");
  recordFailure("a", cfg);
  recordFailure("a", cfg);
  assert(checkRateLimit("a", cfg).allowed, "under the limit is still allowed");

  const tripped = recordFailure("a", cfg);
  assert(!tripped.allowed, "the failure that reaches the limit locks the key out");
  assert(
    tripped.retryAfterSec > 0,
    "a lockout reports how long the caller must wait"
  );
  assert(!checkRateLimit("a", cfg).allowed, "the lockout persists across checks");

  // Per-key isolation: one attacker being locked out must not lock out the
  // operator signing in from somewhere else.
  assert(checkRateLimit("b", cfg).allowed, "a different key is unaffected");

  // A real sign-in wipes the slate, so an operator who mistyped twice is not
  // left one slip away from a lockout for the rest of the window.
  clearRateLimit("a");
  assert(checkRateLimit("a", cfg).allowed, "clearing a key lifts its lockout");

  // An expired window releases the lock.
  __resetRateLimits();
  const expiring = { limit: 1, windowMs: 1 };
  recordFailure("c", expiring);
  assert(!checkRateLimit("c", expiring).allowed, "a fresh lockout is in force");
  const releasedAt = Date.now() + 5;
  while (Date.now() < releasedAt) {
    /* spin briefly — the window is 1ms */
  }
  assert(checkRateLimit("c", expiring).allowed, "the lockout expires with its window");

  const req = new Request("http://localhost/api/auth/login", {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
  });
  assertEqual(clientKey(req), "203.0.113.7", "clientKey takes the leftmost XFF entry");
  assertEqual(
    clientKey(new Request("http://localhost/api/auth/login")),
    "unknown",
    "a request with no forwarding headers still yields a stable key"
  );

  __resetRateLimits();
}

// =============================================================
// 14. Token generation
// =============================================================
console.log("\n14. Token generation\n");

function tokenTests() {
  const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  assertEqual(generateToken(48).length, 48, "a token is exactly the requested length");
  assertEqual(generateToken(1).length, 1, "a one-character token is produced");
  assert(
    [...generateToken(500)].every((c) => ALPHABET.includes(c)),
    "every character comes from the alphabet"
  );

  // `byte % 62` gives the first 8 letters five source values each and the
  // other 54 only four — a ~25% over-representation on every character of
  // every session token and API key. Rejection sampling removes it. Sample
  // enough characters that the old 25% skew is far outside sampling noise
  // while a uniform generator comfortably passes.
  const counts = new Map<string, number>();
  const SAMPLES = 120_000;
  for (const ch of generateToken(SAMPLES)) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  const expected = SAMPLES / ALPHABET.length;
  const biasedHead = [...ALPHABET.slice(0, 8)].reduce(
    (sum, c) => sum + (counts.get(c) || 0),
    0
  ) / 8;
  const rest = [...ALPHABET.slice(8)].reduce(
    (sum, c) => sum + (counts.get(c) || 0),
    0
  ) / (ALPHABET.length - 8);

  assertEqual(counts.size, ALPHABET.length, "the whole alphabet is reachable");
  assert(
    Math.abs(biasedHead / rest - 1) < 0.05,
    `the previously-biased characters are no more likely than the rest ` +
      `(ratio ${(biasedHead / rest).toFixed(3)}, expected ~1.000)`
  );
  assert(
    [...counts.values()].every((n) => Math.abs(n / expected - 1) < 0.12),
    "no single character deviates materially from uniform"
  );

  // Two tokens colliding would mean two sessions sharing an identity.
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(generateToken(24));
  assertEqual(seen.size, 2000, "tokens do not repeat");
}

// =============================================================
// 15. Editor video preview
// =============================================================
console.log("\n15. Editor video preview\n");

import { advancePlayhead, fitRects, sourceTimeAt } from "../../src/lib/editor/video-preview";

function videoPreviewTests() {
  // The whole point of the in-canvas preview is that it shows what will
  // encode. It does that only while its time mapping agrees with the
  // renderer's, so pin the two together: for a range of layer configurations,
  // the preview's continuous mapping must equal the renderer's per-frame one
  // at every frame boundary.
  const fps = 30;
  const configs = [
    { trimStart: 0, trimEnd: 4, startAt: 0, loop: true, playbackRate: 1 },
    { trimStart: 1.5, trimEnd: 3.5, startAt: 0, loop: true, playbackRate: 1 },
    { trimStart: 0, trimEnd: 2, startAt: 1.25, loop: false, playbackRate: 1 },
    { trimStart: 0.5, trimEnd: 2.5, startAt: 0.75, loop: true, playbackRate: 2 },
    { trimStart: 0, trimEnd: 3, startAt: 0, loop: false, playbackRate: 0.5 },
    // Degenerate: an empty trim window has nothing to show, ever.
    { trimStart: 2, trimEnd: 2, startAt: 0, loop: true, playbackRate: 1 },
  ];

  let mismatches = 0;
  for (const cfg of configs) {
    const layer = { ...cfg, layerId: "l", name: "l", videoSrc: "/storage/x.mp4", muted: false, volume: 1, hasAudio: false, boxW: 100, boxH: 100, fit: "cover" as const };
    for (let frame = 0; frame < 200; frame++) {
      const fromRenderer = sourceTimeForFrame(layer, frame, fps);
      const fromPreview = sourceTimeAt(cfg, frame / fps);
      if (fromRenderer === null || fromPreview === null) {
        if (fromRenderer !== fromPreview) mismatches++;
      } else if (Math.abs(fromRenderer - fromPreview) > 1e-9) {
        mismatches++;
      }
    }
  }
  assertEqual(mismatches, 0, "preview time mapping matches the renderer's at every frame");

  // The specific behaviours that mapping encodes, asserted directly so a
  // future change to BOTH sides can't silently redefine them together.
  const clip = { trimStart: 1, trimEnd: 3, startAt: 2, loop: true, playbackRate: 1 };
  assertEqual(sourceTimeAt(clip, 1.9), null, "a layer is hidden before its startAt");
  assertEqual(sourceTimeAt(clip, 2), 1, "a layer opens on its trimStart");
  assertEqual(sourceTimeAt(clip, 3.5), 2.5, "time advances inside the trim window");
  assertEqual(sourceTimeAt(clip, 4.5), 1.5, "a looping clip wraps back to trimStart");
  assertEqual(
    sourceTimeAt({ ...clip, loop: false }, 4.5),
    null,
    "a non-looping clip disappears once it runs out"
  );
  assertEqual(
    sourceTimeAt({ ...clip, playbackRate: 2 }, 2.5),
    2,
    "playbackRate scales how fast the source is consumed"
  );

  // Fit geometry must match what ffmpeg does when decoding frames, or the
  // preview frames a shot differently from the export. Box is 200x100,
  // source is 100x100.
  const cover = fitRects(100, 100, 200, 100, "cover");
  assertEqual(
    [cover.sx, cover.sy, cover.sw, cover.sh],
    [0, 25, 100, 50],
    "cover crops the source to the box's aspect ratio"
  );
  assertEqual(
    [cover.dw, cover.dh, cover.letterbox],
    [200, 100, false],
    "cover fills the box completely"
  );

  const contain = fitRects(100, 100, 200, 100, "contain");
  assertEqual(
    [contain.dw, contain.dh, contain.letterbox],
    [100, 100, true],
    "contain scales the whole frame down and letterboxes the remainder"
  );
  assertEqual([contain.sw, contain.sh], [100, 100], "contain samples the full frame");
  assertEqual(contain.dx, -50, "contain centres the frame horizontally in the box");

  const stretch = fitRects(100, 100, 200, 100, "stretch");
  assertEqual(
    [stretch.sw, stretch.sh, stretch.dw, stretch.dh, stretch.letterbox],
    [100, 100, 200, 100, false],
    "stretch distorts the full frame to fill the box"
  );

  // Destination is centre-origin, because that is the space Fabric hands the
  // object's _renderFill.
  assertEqual([stretch.dx, stretch.dy], [-100, -50], "the destination box is centred on the origin");

  // ---- transport clock ----------------------------------------------------
  // Both of the bugs this covers came from one value trying to be two things:
  // the clock's reference point AND the start of the timeline.
  assertEqual(
    advancePlayhead(0, 1.5, 0, 6),
    { time: 1.5, wrapped: false },
    "the playhead advances by the elapsed time"
  );

  // Resume: the clock is re-based at the PAUSED position, so playing on from
  // 4.5s must continue to 5.5s — not restart the timeline from its beginning.
  assertEqual(
    advancePlayhead(4.5, 1.0, 0, 6),
    { time: 5.5, wrapped: false },
    "resuming continues from where it was paused"
  );

  // Running off the end rewinds to the START of the timeline...
  assertEqual(
    advancePlayhead(5.5, 1.0, 0, 6),
    { time: 0, wrapped: true },
    "reaching the end wraps back to the start"
  );

  // ...and specifically NOT to the clock's origin. Seeking to 5.4 and playing
  // past the end used to rewind to 5.4, which is instantly past the end again,
  // so playback thrashed against the last frame instead of looping.
  assertEqual(
    advancePlayhead(5.4, 1.0, 0, 6),
    { time: 0, wrapped: true },
    "a wrap after a late seek rewinds to the start, not to the seek point"
  );

  // Solo preview of a clip that starts at 3s: its timeline both begins and
  // rewinds to 3, never to 0.
  assertEqual(
    advancePlayhead(6.5, 1.0, 3, 7),
    { time: 3, wrapped: true },
    "a solo timeline wraps to the layer's own startAt"
  );
  assertEqual(
    advancePlayhead(3, 2, 3, 7),
    { time: 5, wrapped: false },
    "a solo timeline advances normally inside its span"
  );

  // Landing exactly on the end counts as the end.
  assertEqual(
    advancePlayhead(5, 1, 0, 6),
    { time: 0, wrapped: true },
    "hitting the duration exactly wraps"
  );

  // A zero-length timeline (nothing set up yet) must not wrap-loop forever.
  assertEqual(
    advancePlayhead(0, 0.5, 0, 0),
    { time: 0.5, wrapped: false },
    "an empty timeline does not pin the playhead at zero"
  );
}

// =============================================================
// UNIVERSAL OUTPUT SETTINGS
// =============================================================
function outputSettingsTests() {
  console.log("\n--- Output settings ---");

  assertEqual(
    resolveOutputSettings(
      { format: "webp", quality: 60, scale: 1, fps: 24 },
      { format: "jpg", quality: 80, scale: 2 },
      { quality: 70 }
    ),
    {
      format: "jpg",
      quality: 70,
      scale: 2,
      fps: 24,
      videoQuality: "balanced",
      durationSec: null,
    },
    "later layers win per key: project → template → request"
  );

  // Blank fields mean "inherit", not "zero" — this is what makes an empty
  // input in the editor keep following the global default.
  assertEqual(
    resolveOutputSettings({ format: "webp", quality: 60 }, { format: "", quality: "", scale: null }),
    {
      format: "webp",
      quality: 60,
      scale: 1,
      fps: 30,
      videoQuality: "balanced",
      durationSec: null,
    },
    "empty strings and nulls inherit instead of overriding"
  );

  assertEqual(normalizeFormat("JPEG"), "jpg", "jpeg normalizes to jpg");
  assertEqual(normalizeFormat("bmp"), undefined, "unknown formats are dropped");
  assertEqual(
    resolveOutputSettings({ scale: 99, quality: 500, fps: 999 }).scale,
    4,
    "out-of-range scale is clamped to the shared maximum"
  );
  assertEqual(
    resolveOutputSettings({ quality: 500 }).quality,
    100,
    "out-of-range quality is clamped"
  );

  assertEqual(
    crfToVideoQuality(videoQualityToCrf("high")),
    "high",
    "video quality survives a round-trip through CRF"
  );

  assertEqual(
    projectDefaultsLayer({
      defaultFormat: "webp",
      defaultQuality: 70,
      defaultScale: 2,
      defaultFps: 24,
      defaultVideoQuality: "small",
    }),
    {
      format: "webp",
      quality: 70,
      scale: 2,
      fps: 24,
      videoQuality: "small",
    },
    "a project row maps onto a settings layer"
  );

  // Bigger scale means more pixels means a bigger file — the estimate the
  // editor and Playground both show has to move with it.
  const small = estimateOutputBytes({
    width: 1080,
    height: 1350,
    scale: 1,
    format: "png",
    quality: 90,
  });
  const large = estimateOutputBytes({
    width: 1080,
    height: 1350,
    scale: 2,
    format: "png",
    quality: 90,
  });
  assert(large === small * 4, "size estimate scales with pixel count");
}

// =============================================================
// RENDER TIME ESTIMATES
// =============================================================
function renderTimeTests() {
  console.log("\n--- Render time ---");

  const stats = buildRenderTimeStats(
    [
      { kind: "image", templateId: "tmpl_a", durationMs: 1000, megapixels: 1, frames: null },
      { kind: "image", templateId: "tmpl_a", durationMs: 2000, megapixels: 2, frames: null },
      { kind: "image", templateId: "tmpl_a", durationMs: 3000, megapixels: 3, frames: null },
      { kind: "video", templateId: "tmpl_b", durationMs: 30_000, megapixels: 2, frames: 300 },
    ],
    0,
    { image: 3, video: 1 }
  );

  assertEqual(stats.image?.samples, 3, "image bucket counts its samples");
  assertEqual(stats.image?.msPerMegapixel, 1000, "median ms per megapixel");
  assertEqual(stats.video?.msPerFrame, 100, "median ms per encoded frame");

  // 4 megapixels of output at 1000 ms/MP.
  const imageEstimate = estimateRenderMs(stats, {
    kind: "image",
    templateId: "tmpl_a",
    width: 1000,
    height: 1000,
    scale: 2,
  });
  assertEqual(imageEstimate.ms, 4000, "image estimate scales with output megapixels");
  assertEqual(imageEstimate.basis, "template", "per-template history is preferred");

  // 60 fps x 10s = 600 frames at 100 ms/frame. The video bucket has a single
  // sample, so it is used at project level rather than per template.
  const videoEstimate = estimateRenderMs(stats, {
    kind: "video",
    templateId: "tmpl_b",
    width: 1000,
    height: 1000,
    scale: 1,
    fps: 60,
    durationSec: 10,
  });
  assertEqual(videoEstimate.ms, 60_000, "video estimate scales with frame count");
  assertEqual(videoEstimate.basis, "project", "a thin per-template bucket falls back to the project");

  const cold = estimateRenderMs(null, { kind: "image", width: 1000, height: 1000, scale: 1 });
  assert(cold.samples === 0 && cold.basis === "estimate", "no history gives a labelled cold-start guess");
  assert(cold.ms > 0, "the cold-start guess is still a usable number");

  // Once a video job reports real progress, its own pace beats the average.
  assertEqual(
    remainingMs({ elapsedMs: 10_000, progress: 50, estimateMs: 999_999 }),
    10_000,
    "in-flight progress drives the remaining time"
  );
  assertEqual(
    remainingMs({ elapsedMs: 1000, progress: 0, estimateMs: 5000 }),
    4000,
    "with no progress reported the estimate drives it"
  );
  assertEqual(
    remainingMs({ elapsedMs: 9000, progress: null, estimateMs: 5000 }),
    0,
    "an overrunning render never reports negative time left"
  );

  // A batch runs `concurrency` at a time, so it is not count x per-render.
  assertEqual(estimateBatchMs(1000, 10, 3), 4000, "batch time accounts for render concurrency");
  assertEqual(estimateBatchMs(1000, 1, 3), 1000, "a single render is one wave");

  assertEqual(formatRenderTime(573), "573ms", "sub-second times keep milliseconds");
  assertEqual(formatRenderTime(4200), "4.2s", "seconds get one decimal");
  assertEqual(formatRenderTime(125_000), "2m 05s", "minutes are padded");
  assertEqual(formatEta(3400), "~3s", "an ETA is rounded to whole seconds");
  assertEqual(formatEta(400), "<1s", "a sub-second ETA is not rounded away to zero");
}

// =============================================================
// RESULTS
// =============================================================
outputSettingsTests();
renderTimeTests();
rateLimitTests();
tokenTests();
videoPreviewTests();

renderFontTests().then(apiKeyTests).then(ssrfTests).then(() => {
  console.log("\n================================================================");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("================================================================");

  if (failed > 0) {
    process.exit(1);
  }
});
