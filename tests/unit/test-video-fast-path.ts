/**
 * Unit tests for the fast-path video renderer's pure logic:
 *   - the "simple template" detector (simple-template.ts)
 *   - the ffmpeg filter-graph builder (filtergraph.ts)
 *   - shared audio mixing (audio.ts)
 * Run: npx tsx tests/unit/test-video-fast-path.ts
 */

import { auditVideoObjects, loopCacheWithinBudget } from "../../src/lib/video/simple-template";
import { chooseRenderer } from "../../src/lib/video/renderer-choice";
import {
  buildFastRenderArgs,
  enableWindowSec,
  fitFilterExpr,
  layerBoxSize,
  overlayPixelPosition,
} from "../../src/lib/video/filtergraph";
import { buildAudioMixFilters, layerWantsAudio } from "../../src/lib/video/audio";
import { buildVideoCodecArgs, resolveVideoEncoder } from "../../src/lib/video/encode";
import type { VideoLayer } from "../../src/lib/video/timeline";

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

function videoLayer(overrides: Partial<VideoLayer> = {}): VideoLayer {
  return {
    layerId: "vid1",
    name: "hero",
    videoSrc: "/storage/uploads/clip.mp4",
    trimStart: 0,
    trimEnd: 10,
    startAt: 0,
    loop: false,
    muted: false,
    volume: 1,
    playbackRate: 1,
    hasAudio: false,
    boxW: 480,
    boxH: 270,
    fit: "cover",
    ...overrides,
  };
}

function videoObject(overrides: Record<string, any> = {}): any {
  return {
    type: "Image",
    id: "vid1",
    name: "hero",
    mediaType: "video",
    videoSrc: "/storage/uploads/clip.mp4",
    left: 100,
    top: 50,
    width: 480,
    height: 270,
    scaleX: 1,
    scaleY: 1,
    ...overrides,
  };
}

console.log("================================================================");
console.log("  VIDEO FAST PATH — unit tests");
console.log("================================================================\n");

// =============================================================
// 1. Simple-template detector
// =============================================================
console.log("1. simple-template detector\n");

{
  const facts = auditVideoObjects({ objects: [videoObject()] });
  assert(facts.audit.simple, "a plain video object is simple");
  assertEqual(facts.count, 1, "count counts every video object");
  assertEqual(facts.overlayCandidates.length, 1, "visible video objects are overlay candidates");

  assert(
    !auditVideoObjects({ objects: [videoObject({ angle: 15 })] }).audit.simple,
    "angle ≠ 0 forces the legacy path"
  );
  assert(
    auditVideoObjects({ objects: [videoObject({ angle: 360 })] }).audit.simple,
    "angle 360 normalizes to 0 and stays simple"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ angle: -90 })] }).audit.simple,
    "negative angle forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ clipPath: { type: "rect" } })] }).audit.simple,
    "clipPath forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ skewX: 10 })] }).audit.simple,
    "skewX forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ flipX: true })] }).audit.simple,
    "flipX forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ scaleX: -1 })] }).audit.simple,
    "negative scaleX (mirror) forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ shadow: { blur: 4 } })] }).audit.simple,
    "shadow forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ strokeWidth: 2 })] }).audit.simple,
    "stroke forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ filters: [{ type: "Grayscale" }] })] }).audit.simple,
    "Fabric image filters force the legacy path"
  );
  assert(
    auditVideoObjects({ objects: [videoObject({ opacity: 0.7 })] }).audit.simple,
    "constant opacity < 1 is simple"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ opacity: "0.5" })] }).audit.simple,
    "non-numeric opacity forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [videoObject({ originX: "center", originY: "banana" })] }).audit.simple,
    "unknown originY forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [{ type: "group", objects: [videoObject()] }] }).audit.simple,
    "video nested in a group forces the legacy path"
  );
  assert(
    !auditVideoObjects({ objects: [{ type: "group", objects: [videoObject({ visible: false })] }] }).audit.simple,
    "a HIDDEN video nested in a group still forces the legacy path"
  );
  assert(
    auditVideoObjects({ objects: [videoObject({ visible: false, angle: 42 })] }).audit.simple,
    "an invisible video object is skipped by the audit"
  );
  assertEqual(
    auditVideoObjects({ objects: [videoObject({ visible: false })] }).overlayCandidates.length,
    0,
    "an invisible video object is not an overlay candidate"
  );
  assert(
    auditVideoObjects({ objects: [{ type: "Rect", mediaType: "video", videoSrc: "/x.mp4" }] }).audit.simple,
    "non-image objects are ignored (and there is nothing to audit)"
  );

  // Loop-cache budget: a long looping 4K box must trip the budget at a tiny
  // limit, a small looping box must pass.
  const longLoop = videoLayer({ loop: true, trimStart: 0, trimEnd: 60, boxW: 3840, boxH: 2160 });
  assertEqual(
    loopCacheWithinBudget([longLoop], 30, 1),
    false,
    "a 60s looping 4K layer is rejected at a 1MB budget"
  );
  const smallLoop = videoLayer({ loop: true, trimStart: 0, trimEnd: 1, boxW: 100, boxH: 100 });
  assertEqual(
    loopCacheWithinBudget([smallLoop], 30, 1),
    true,
    "a 1s looping 100x100 layer fits a 1MB budget"
  );
  const notLooping = videoLayer({ loop: false, trimStart: 0, trimEnd: 60, boxW: 3840, boxH: 2160 });
  assertEqual(
    loopCacheWithinBudget([notLooping], 30, 1),
    true,
    "non-looping layers never trip the loop budget"
  );
  assertEqual(
    loopCacheWithinBudget([videoLayer({ loop: true, trimStart: 3, trimEnd: 3 })], 30, 1),
    true,
    "an empty trim window (dead layer) never trips the loop budget"
  );
}

// =============================================================
// 2. Filter-graph builder — geometry and windows
// =============================================================
console.log("\n2. filter-graph geometry and enable windows\n");

{
  assertEqual(layerBoxSize(videoLayer({ boxW: 480, boxH: 270 }), 1), { w: 480, h: 270 }, "box size at scale 1");
  assertEqual(layerBoxSize(videoLayer({ boxW: 480, boxH: 270 }), 2), { w: 960, h: 540 }, "box size at scale 2");

  assertEqual(
    fitFilterExpr("cover", 480, 270),
    "scale=480:270:force_original_aspect_ratio=increase,crop=480:270",
    "cover scales up then crops"
  );
  assertEqual(
    fitFilterExpr("contain", 480, 270),
    "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black",
    "contain scales down then pads (identical to decode.ts)"
  );
  assertEqual(fitFilterExpr("stretch", 480, 270), "scale=480:270", "stretch distorts to the box");

  // Fabric semantics: originX "left" (default) means left is the CENTER x.
  assertEqual(
    overlayPixelPosition({ left: 100, top: 50, opacity: 1 }, videoLayer({ boxW: 480, boxH: 270 }), 1),
    { x: 100, y: 50 },
    "default origin left/top anchors the box's left edge at left/top"
  );
  assertEqual(
    overlayPixelPosition({ left: 100, top: 50, originX: "center", originY: "center", opacity: 1 }, videoLayer({ boxW: 100, boxH: 100 }), 1),
    { x: 50, y: 0 },
    "origin center puts the box corner at left+50/top"
  );
  assertEqual(
    overlayPixelPosition({ left: 100, top: 50, originX: "right", originY: "bottom", opacity: 1 }, videoLayer({ boxW: 100, boxH: 100 }), 2),
    { x: 0, y: -100 },
    "origin right/bottom anchors the box's right/bottom edge at left/top"
  );

  assertEqual(
    enableWindowSec(videoLayer({ startAt: 2, trimStart: 0, trimEnd: 3, playbackRate: 1, loop: false }), 30),
    { start: 2, end: 5 },
    "non-looping window ends after the rate-adjusted span"
  );
  assertEqual(
    enableWindowSec(videoLayer({ startAt: 2, trimStart: 0, trimEnd: 4, playbackRate: 2, loop: false }), 30),
    { start: 2, end: 4 },
    "playbackRate 2 halves the visible window"
  );
  assertEqual(
    enableWindowSec(videoLayer({ startAt: 2, loop: true, trimStart: 0, trimEnd: 1 }), 30),
    { start: 2, end: 30 },
    "a looping layer stays enabled until the timeline ends"
  );
  assertEqual(
    enableWindowSec(videoLayer({ startAt: 2, trimStart: 3, trimEnd: 3, loop: false }), 30),
    null,
    "an empty trim window is a dead layer (null window)"
  );
  assertEqual(
    enableWindowSec(videoLayer({ startAt: 0.5, trimStart: 0, trimEnd: 3, loop: false }), 30),
    { start: 0.5, end: 3.5 },
    "enable window keeps the raw startAt (visibility boundary)"
  );
}

// =============================================================
// 3. Filter-graph builder — full argv
// =============================================================
console.log("\n3. full ffmpeg argv\n");

const basePlan = {
  basePngPath: "/tmp/base.png",
  overlays: [] as any[],
  width: 640,
  height: 480,
  outputScale: 1,
  evenWidth: 640,
  evenHeight: 480,
  fps: 30,
  durationSec: 10,
  crf: 23,
  encoder: "libx264" as const,
  outputPath: "/tmp/out.mp4",
  progress: false,
};

{
  // Single video layer, contain fit, startAt offset.
  const plan = {
    ...basePlan,
    overlays: [
      {
        kind: "video" as const,
        layer: videoLayer({ fit: "contain", startAt: 1.5, trimStart: 2, trimEnd: 5 }),
        sourcePath: "/tmp/clip.mp4",
        geometry: { left: 100, top: 50, opacity: 1 },
        hasAudioStream: false,
      },
    ],
  };
  const { args, audioInputCount } = buildFastRenderArgs(plan);
  assertEqual(audioInputCount, 0, "no audio inputs without hasAudioStream");

  const fc = args[args.indexOf("-filter_complex") + 1];
  assert(
    fc.includes("[1:v]fps=30,scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black,setpts=N/(30*TB),setpts=PTS-STARTPTS+1.5/TB[v0]"),
    "video chain: fps → exact grid re-index (decode.ts frame mapping) → contain scale+pad → setpts to startAt"
  );
  assert(
    fc.includes("[0:v][v0]overlay=x=100:y=50:eof_action=pass:enable='between(t,1.5,4.5)'[o0]"),
    "overlay at the computed pixel with a between() enable window"
  );
  assert(
    fc.includes("setpts=PTS-STARTPTS+1.5/TB"),
    "the layer lands exactly on startAt (post-ss PTS base normalized away)"
  );
  assert(fc.endsWith("[o0]scale=640:480:force_original_aspect_ratio=disable[vout]"), "final scale labels [vout]");
  const clipIdx = args.indexOf("/tmp/clip.mp4");
  assertEqual([args[clipIdx - 4], args[clipIdx - 2]], ["2", "5"], "video input trimmed with -ss/-to directly before -i");
  assert(!args.includes("-progress"), "no -progress unless requested");
  assert(
    args.includes("-c:v") && args[args.indexOf("-c:v") + 1] === "libx264" &&
      args.includes("-crf") && args[args.indexOf("-crf") + 1] === "23" &&
      args.includes("yuv420p") && args.includes("+faststart"),
    "libx264 veryfast + crf + yuv420p + faststart"
  );
  assertEqual(args[args.indexOf("-t") + 1], "10", "output bounded by -t durationSec");
  assert(!args.includes("-shortest"), "fast path never passes -shortest");
}

{
  // cover + stretch chains.
  const coverArgs = buildFastRenderArgs({
    ...basePlan,
    overlays: [{ kind: "video" as const, layer: videoLayer({ fit: "cover" }), sourcePath: "/tmp/c.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false }],
  }).args;
  assert(coverArgs[coverArgs.indexOf("-filter_complex") + 1].includes("scale=480:270:force_original_aspect_ratio=increase,crop=480:270"), "cover chain matches decode.ts");

  const stretchArgs = buildFastRenderArgs({
    ...basePlan,
    overlays: [{ kind: "video" as const, layer: videoLayer({ fit: "stretch" }), sourcePath: "/tmp/s.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false }],
  }).args;
  assert(stretchArgs[stretchArgs.indexOf("-filter_complex") + 1].includes("scale=480:270,"), "stretch chain matches decode.ts");
}

{
  // Multiple layers with a static patch between them, plus audio.
  const plan = {
    ...basePlan,
    overlays: [
      {
        kind: "video" as const,
        layer: videoLayer({ layerId: "a", name: "a", startAt: 0, loop: true, trimStart: 1, trimEnd: 4, hasAudio: true, volume: 0.5 }),
        sourcePath: "/tmp/a.mp4",
        geometry: { left: 0, top: 0, opacity: 1 },
        hasAudioStream: true,
      },
      { kind: "static" as const, pngPath: "/tmp/fg.png" },
      {
        kind: "video" as const,
        layer: videoLayer({ layerId: "b", name: "b", startAt: 2, hasAudio: true, muted: true }),
        sourcePath: "/tmp/b.mp4",
        geometry: { left: 10, top: 20, opacity: 1 },
        hasAudioStream: true,
      },
    ],
  };
  const { args, audioInputCount } = buildFastRenderArgs(plan);
  assertEqual(audioInputCount, 1, "muted layer contributes no audio input; looping layer does");
  const fc = args[args.indexOf("-filter_complex") + 1];
  // durationSec 10, visible window 10s, span 3s → ceil(10/3) − 1 = 3 repeats.
  assert(fc.includes("loop=loop=3:size=91:start=0"), "looping layer repeats a finite number of times covering its window");
  assertEqual((fc.match(/loop=loop=/g) || []).length, 1, "non-looping layer has no loop filter");
  assert(
    fc.includes("[0:v][v0]overlay") && fc.includes("[o0][3:v]overlay=x=0:y=0") &&
      fc.includes("[s1][v2]overlay") && fc.includes("[o2]scale"),
    "z-order: base → video a → static patch → video b → scale"
  );
  assert(fc.includes("[2:a]adelay=0|0,volume=0.5[a0];[a0]amix=inputs=1:dropout_transition=0,apad=whole_dur=10[aout]"), "audio mix: adelay + volume + amix padded to the duration");
  const inputs = args.reduce((n: number, a: string, idx: number) => (a === "-i" ? n + 1 : n), 0);
  assertEqual(inputs, 5, "inputs: base PNG, video a, audio a, static patch, video b");
}

{
  // Dead and invisible layers disappear from the graph entirely.
  const { args } = buildFastRenderArgs({
    ...basePlan,
    overlays: [
      { kind: "video" as const, layer: videoLayer({ trimStart: 5, trimEnd: 5, startAt: 0 }), sourcePath: "/tmp/dead.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false },
      { kind: "video" as const, layer: videoLayer({ startAt: 20, trimStart: 0, trimEnd: 1 }), sourcePath: "/tmp/late.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false },
    ],
  });
  assert(!args.join(" ").includes("/tmp/dead.mp4") && !args.join(" ").includes("/tmp/late.mp4"), "dead layers open no inputs");
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert(fc.startsWith("[0:v]scale="), "with no live overlays the base goes straight to the final scale");
}

{
  // Constant opacity < 1 applies colorchannelmixer on rgba.
  const opacityArgs = buildFastRenderArgs({
    ...basePlan,
    overlays: [{ kind: "video" as const, layer: videoLayer(), sourcePath: "/tmp/c.mp4", geometry: { left: 0, top: 0, opacity: 0.4 }, hasAudioStream: false }],
  }).args;
  assert(opacityArgs[opacityArgs.indexOf("-filter_complex") + 1].includes("format=rgba,colorchannelmixer=aa=0.4"), "constant opacity maps to colorchannelmixer alpha");
}

{
  // Progress + playbackRate.
  const res = buildFastRenderArgs({
    ...basePlan,
    progress: true,
    overlays: [{ kind: "video" as const, layer: videoLayer({ playbackRate: 2 }), sourcePath: "/tmp/c.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false }],
  });
  assert(res.args.includes("-progress") && res.args.includes("pipe:1"), "progress mode emits -progress pipe:1");
  assert(res.args[res.args.indexOf("-filter_complex") + 1].includes("setpts=N/(30*TB),setpts=PTS/2"), "playbackRate divides the gridded PTS");
}

{
  // Landing time: ceil(startAt × fps)/fps — legacy's first visible frame.
  // (Read out of the generated chain so the test pins the full expression.)
  const landChain = (startAt: number, fps: number) => {
    const res = buildFastRenderArgs({
      ...basePlan,
      fps,
      durationSec: 30,
      overlays: [{ kind: "video" as const, layer: videoLayer({ startAt, trimStart: 0, trimEnd: 20 }), sourcePath: "/tmp/l.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false }],
    });
    const fc = res.args[res.args.indexOf("-filter_complex") + 1];
    const m = fc.match(/setpts=PTS-STARTPTS\+([0-9.]+)\/TB/);
    return m ? Number(m[1]) : NaN;
  };
  assertEqual(landChain(0.5, 15), Number((8 / 15).toFixed(6)), "off-grid startAt 0.5s @15fps lands on frame 8");
  assertEqual(landChain(2, 30), 2, "on-grid startAt lands exactly on startAt");
  assertEqual(landChain(1.0333, 30), Number((Math.ceil(1.0333 * 30) / 30).toFixed(6)), "fractional startAt rounds up to the next frame");

  // Finite loop repeats (an infinite loop filter hangs ffmpeg past -t):
  // repeats = ceil(window/span) − 1.
  const loopRepeats = (durationSec: number, span: number) => {
    const res = buildFastRenderArgs({
      ...basePlan,
      durationSec,
      overlays: [{ kind: "video" as const, layer: videoLayer({ loop: true, trimStart: 0, trimEnd: span }), sourcePath: "/tmp/l.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false }],
    });
    const fc = res.args[res.args.indexOf("-filter_complex") + 1];
    const m = fc.match(/loop=loop=(\d+):/);
    return m ? Number(m[1]) : 0;
  };
  assertEqual(loopRepeats(10, 3), 3, "10s window over a 3s loop repeats 3× (covers 12s ≥ 10s)");
  assertEqual(loopRepeats(6, 3), 1, "6s window over a 3s loop repeats exactly 1×");
  assertEqual(loopRepeats(3, 3), 0, "a window equal to the span needs no loop filter at all");
  assertEqual(loopRepeats(2, 5), 0, "a window shorter than the span needs no loop filter");

  // The grid re-index must come AFTER the loop filter: `loop` replays its
  // cache with restarting (non-monotonic) pts, which framesync drops — the
  // overlay would go blank after the first period.
  const loopedFc = buildFastRenderArgs({
    ...basePlan,
    durationSec: 10,
    overlays: [{ kind: "video" as const, layer: videoLayer({ loop: true, trimStart: 0, trimEnd: 3 }), sourcePath: "/tmp/l.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false }],
  }).args;
  const looped = loopedFc[loopedFc.indexOf("-filter_complex") + 1];
  assert(
    looped.indexOf("loop=loop=") < looped.indexOf("setpts=N/(30*TB)"),
    "grid re-index runs after the loop filter (monotonic pts across wraps)"
  );
  // Repeats must scale with playbackRate: a 2× rate consumes the source twice
  // as fast (5s window × 2 ÷ 2s span → 5 plays → 4 repeats).
  const rate2 = buildFastRenderArgs({
    ...basePlan,
    durationSec: 5,
    overlays: [{ kind: "video" as const, layer: videoLayer({ loop: true, trimStart: 0, trimEnd: 2, playbackRate: 2 }), sourcePath: "/tmp/l.mp4", geometry: { left: 0, top: 0, opacity: 1 }, hasAudioStream: false }],
  }).args;
  assert(rate2[rate2.indexOf("-filter_complex") + 1].includes("loop=loop=4:"), "loop repeats scale with playbackRate");
}

// =============================================================
// 4. Shared audio mixing + encoder selection
// =============================================================
console.log("\n4. audio mixing and encoder selection\n");

{
  assertEqual(buildAudioMixFilters([]).filters, [], "no entries → no filters");
  const plan = buildAudioMixFilters([
    { inputIndex: 2, startAtSec: 1.25, volume: 0.8 },
    { inputIndex: 5, startAtSec: 0, volume: 1 },
  ]);
  assertEqual(
    plan.filters,
    [
      "[2:a]adelay=1250|1250,volume=0.8[a0]",
      "[5:a]adelay=0|0,volume=1[a1]",
      "[a0][a1]amix=inputs=2:dropout_transition=0[aout]",
    ],
    "mix chain matches the legacy encoder's adelay/volume/amix"
  );
  assert(layerWantsAudio({ hasAudio: true, muted: false, volume: 0.5 }), "audible layer wants audio");
  assert(!layerWantsAudio({ hasAudio: true, muted: true, volume: 0.5 }), "muted layer does not");
  assert(!layerWantsAudio({ hasAudio: true, muted: false, volume: 0 }), "zero-volume layer does not");
  assert(!layerWantsAudio({ hasAudio: false, muted: false, volume: 1 }), "hasAudio=false does not");

  assertEqual(buildVideoCodecArgs("libx264", 23), ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"], "libx264 args unchanged from the legacy encoder");
  assertEqual(
    buildVideoCodecArgs("h264_nvenc", 23),
    ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
    "nvenc args: -b:v 0 so -cq governs quality"
  );
  const vt = buildVideoCodecArgs("h264_videotoolbox", 23);
  assertEqual(vt.length, 4, "videotoolbox swaps only the codec flags");
  assertEqual(vt[3], "52", "videotoolbox maps CRF 23 to the 1-100 quality dial");
  assertEqual(buildVideoCodecArgs("h264_videotoolbox", 35)[3], "1", "videotoolbox quality clamps at 1");
  assertEqual(buildVideoCodecArgs("h264_videotoolbox", 12)[3], "100", "videotoolbox quality clamps at 100");
  assertEqual(buildVideoCodecArgs("h264_vaapi", 23), ["-c:v", "h264_vaapi", "-qp", "23"], "vaapi codec args unchanged");
  assertEqual(resolveVideoEncoder(), "libx264", "default encoder is libx264");
}

// =============================================================
// 5. Renderer choice (the dispatcher's decision)
// =============================================================
console.log("\n5. renderer choice\n");

{
  const layers = [videoLayer()];
  assertEqual(
    chooseRenderer({ objects: [videoObject()] }, { layers, fps: 30, outputScale: 1, forceLegacy: false }).renderer,
    "ffmpeg",
    "a simple template takes the fast path"
  );
  const rotated = chooseRenderer({ objects: [videoObject({ angle: 10 })] }, { layers, fps: 30, outputScale: 1, forceLegacy: false });
  assertEqual(rotated.renderer, "chromium", "a rotated video layer takes the legacy path");
  assert(Boolean(rotated.reason?.includes("angle")), "the logged reason mentions the offending property");

  assertEqual(
    chooseRenderer({ objects: [videoObject()] }, { layers, fps: 30, outputScale: 1, forceLegacy: true }).renderer,
    "chromium",
    "VIDEO_FORCE_LEGACY_RENDERER pins the legacy path"
  );
  assertEqual(
    chooseRenderer({ objects: [videoObject()] }, { layers, fps: 30, outputScale: 1, forceLegacy: true }).reason,
    "forced by VIDEO_FORCE_LEGACY_RENDERER",
    "the forced reason is logged"
  );
  const bigLoop = videoLayer({ loop: true, trimStart: 0, trimEnd: 60, boxW: 3840, boxH: 2160 });
  const bigLoopChoice = chooseRenderer(
    { objects: [videoObject({ loop: true, trimStart: 0, trimEnd: 60, width: 3840, height: 2160 })] },
    { layers: [bigLoop], fps: 30, outputScale: 1, forceLegacy: false }
  );
  assertEqual(bigLoopChoice.renderer, "chromium", "an oversized loop cache takes the legacy path");
  assert(Boolean(bigLoopChoice.reason?.includes("VIDEO_FFMPEG_LOOP_MEMORY_MB")), "the loop-budget reason is logged");
}

console.log("\n================================================================");
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log("================================================================");

if (failed > 0) process.exit(1);
