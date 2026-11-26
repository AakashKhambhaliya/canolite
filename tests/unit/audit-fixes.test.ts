/**
 * Regression tests for the fixes from the codebase audit. Pure modules only —
 * nothing here needs a database, Chromium or the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetRateLimits,
  checkRateLimit,
  releaseAttempt,
  reserveAttempt,
} from "../../src/lib/rate-limit";
import { BodyError, readJsonBody, readJsonBodyOrNull } from "../../src/lib/json-body";
import { buildTimeline, collectVideoLayers, MAX_PLAYBACK_RATE } from "../../src/lib/video/timeline";
import { buildVideoChainFilters, enableWindowSec } from "../../src/lib/video/filtergraph";
import { buildEncodeArgs } from "../../src/lib/video/encode";
import { createUrlSafetyChecker, TooManyHostsError } from "../../src/lib/ssrf";
import { isUuid } from "../../src/lib/utils";
import { walkDesignObjects } from "../../src/lib/design/walk";

const cfg = { limit: 3, windowMs: 60_000 };

test("rate limit: a concurrent burst can't exceed the limit", () => {
  __resetRateLimits();
  // Reservations are synchronous, so N callers in one tick see each other.
  const results = Array.from({ length: 10 }, () => reserveAttempt("k", cfg));
  assert.equal(results.filter((r) => r.allowed).length, 3);
  assert.equal(checkRateLimit("k", cfg).allowed, false);
});

test("rate limit: a released slot is handed back", () => {
  __resetRateLimits();
  for (let i = 0; i < 3; i++) reserveAttempt("k", cfg);
  releaseAttempt("k");
  assert.equal(reserveAttempt("k", cfg).allowed, true);
  assert.equal(reserveAttempt("k", cfg).allowed, false);
});

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/x", { method: "POST", body, headers });
}

test("json body: parses, treats empty as {}, rejects oversize and garbage", async () => {
  assert.deepEqual(await readJsonBody(jsonRequest('{"a":1}')), { a: 1 });
  assert.deepEqual(await readJsonBody(jsonRequest("")), {});
  await assert.rejects(readJsonBody(jsonRequest("x".repeat(100)), 10), (e: unknown) => e instanceof BodyError && e.status === 413);
  await assert.rejects(readJsonBody(jsonRequest("{nope")), (e: unknown) => e instanceof BodyError && e.status === 400);
  assert.equal(await readJsonBodyOrNull(jsonRequest("{nope"), 1000), null);
});

function videoObj(extra: Record<string, unknown> = {}) {
  return { type: "Image", mediaType: "video", videoSrc: "/storage/v.mp4", width: 100, height: 100, videoDuration: 4, ...extra };
}

test("timeline: zero-span looping layer is dead, not loop=Infinity", () => {
  const [layer] = collectVideoLayers({ objects: [videoObj({ trimStart: 2, trimEnd: 2 })] });
  assert.equal(enableWindowSec(layer, 10), null);
  const chain = buildVideoChainFilters({
    layer, fps: 30, outputScale: 1, durationSec: 10,
    geometry: { left: 0, top: 0, opacity: 1 },
  });
  assert.equal(chain, null);
});

test("timeline: playback rate is clamped and a too-long timeline is refused", () => {
  const [fast] = collectVideoLayers({ objects: [videoObj({ playbackRate: 1e9 })] });
  assert.equal(fast.playbackRate, MAX_PLAYBACK_RATE);
  // startAt far past the cap: a low fps used to slip under the frame-count check.
  assert.throws(() => buildTimeline({ objects: [videoObj({ startAt: 7190 })] }, { fps: 1 }), /too long/);
});

test("timeline: mirrored layers keep their size; duplicate ids get distinct paths", () => {
  const layers = collectVideoLayers({
    objects: [videoObj({ id: "dup", scaleX: -2 }), videoObj({ id: "dup" })],
  });
  assert.equal(layers[0].boxW, 200);
  assert.notEqual(layers[0].layerPath, layers[1].layerPath);
});

test("encode: audio is padded to the timeline instead of -shortest", () => {
  const audioLayer = (path?: string) => ({
    layer: { startAt: 0, volume: 1 } as any, sourcePath: "", framesDir: "", frameExt: "jpg" as const, frameCount: 1, audioPath: path,
  });
  const args = buildEncodeArgs({
    outPath: "out.mp4", width: 100, height: 100, fps: 30, crf: 23,
    audioLayers: [audioLayer(undefined), audioLayer("a.m4a")],
    durationSec: 7,
  });
  assert.ok(!args.includes("-shortest"));
  assert.equal(args[args.indexOf("-t") + 1], "7");
  // The only audio input is input #1, even though it was the 2nd list entry.
  assert.ok(args[args.indexOf("-filter_complex") + 1].includes("[1:a]"));
});

test("url checker: caps distinct hosts and rejects non-public targets", async () => {
  const check = createUrlSafetyChecker({ maxHosts: 2 });
  assert.equal(await check("http://127.0.0.1/a.png"), false);
  assert.equal(await check("http://user:pw@8.8.8.8/a.png"), false);
  assert.equal(await check("http://8.8.8.8/a.png"), true);
  assert.equal(await check("http://8.8.8.8/b.png"), true); // same host, cached
  await assert.rejects(check("http://1.1.1.1/c.png"), TooManyHostsError);
});

test("misc: isUuid and null-tolerant design walking", () => {
  assert.equal(isUuid("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), true);
  assert.equal(isUuid("img_abc"), false);
  const seen: string[] = [];
  walkDesignObjects({ objects: [null, { name: "a" }, 5] } as any, ({ object }) => seen.push((object as any).name));
  assert.deepEqual(seen, ["a"]);
});
