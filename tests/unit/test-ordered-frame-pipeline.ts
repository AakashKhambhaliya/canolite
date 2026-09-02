/**
 * Unit tests for OrderedFramePipeline — the reorder buffer that lets N
 * parallel Chromium pages render frames out of order while the encoder
 * receives them strictly in frame order, with bounded memory.
 * Run: npx tsx tests/unit/test-ordered-frame-pipeline.ts
 */

import { OrderedFramePipeline } from "../../src/lib/video/ordered-frame-pipeline";

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("================================================================");
  console.log("  ORDERED FRAME PIPELINE — unit tests");
  console.log("================================================================\n");

  {
    // In-order completion is the trivial case.
    const consumed: number[] = [];
    const p = new OrderedFramePipeline<number>({
      workerCount: 2,
      produce: async (i) => i,
      consume: async (frame, i) => {
        assertEqual(frame, i, "frame value matches its index");
        consumed.push(i);
      },
    });
    await p.run(10);
    assertEqual(consumed, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "in-order producers consume in order");
  }

  {
    // Deliberately skewed production: later frames resolve faster. The
    // consumer must still see strictly increasing order.
    const consumed: number[] = [];
    const p = new OrderedFramePipeline<number>({
      workerCount: 3,
      produce: async (i) => {
        // Frame 0 is slowest; every later frame is faster than the previous.
        await delay((20 - i) * 3);
        return i;
      },
      consume: async (frame, i) => {
        consumed.push(i);
        if (frame !== i) throw new Error(`out of order: got ${frame} at ${i}`);
      },
    });
    await p.run(24);
    assertEqual(consumed.length, 24, "all frames consumed");
    assertEqual(
      consumed.every((v, idx) => v === idx),
      true,
      "skewed producers still consume strictly in frame order"
    );
  }

  {
    // Back-pressure: memory must stay bounded no matter how fast producers
    // are relative to the consumer.
    let maxBuffered = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const p = new OrderedFramePipeline<number>({
      workerCount: 4,
      maxBuffered: 3,
      produce: async (i) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(1);
        concurrent -= 1;
        return i;
      },
      consume: async (_frame, i) => {
        maxBuffered = Math.max(maxBuffered, p.bufferedCount);
        await delay(5); // consumer slower than producer
        if (i === 0) maxBuffered = Math.max(maxBuffered, p.bufferedCount);
      },
    });
    await p.run(40);
    assert(
      maxBuffered <= 3,
      `reorder buffer never exceeds maxBuffered (peak ${maxBuffered})`
    );
    assert(
      maxConcurrent <= 4,
      `never more in-flight renders than workers (peak ${maxConcurrent})`
    );
  }

  {
    // Empty input is a no-op; a single frame works with any worker count.
    const p1 = new OrderedFramePipeline<number>({ workerCount: 4, produce: async () => 1, consume: async () => {} });
    await p1.run(0);
    assert(true, "zero frames completes");

    const seen: number[] = [];
    const p2 = new OrderedFramePipeline<number>({
      workerCount: 8,
      produce: async (i) => i,
      consume: async (_f, i) => {
        seen.push(i);
      },
    });
    await p2.run(1);
    assertEqual(seen, [0], "single frame with 8 workers");
  }

  {
    // Producer failure surfaces at the consumed frame, not silently.
    const p = new OrderedFramePipeline<number>({
      workerCount: 2,
      produce: async (i) => {
        if (i === 3) throw new Error("render exploded");
        return i;
      },
      consume: async () => {},
    });
    let error: any = null;
    try {
      await p.run(10);
    } catch (e) {
      error = e;
    }
    assert(error && /render exploded/.test(error.message), "producer rejection propagates to the caller");
  }

  {
    // Consumer failure surfaces too.
    const p = new OrderedFramePipeline<number>({
      workerCount: 2,
      produce: async (i) => i,
      consume: async (_f, i) => {
        if (i === 2) throw new Error("encoder died");
      },
    });
    let error: any = null;
    try {
      await p.run(6);
    } catch (e) {
      error = e;
    }
    assert(error && /encoder died/.test(error.message), "consumer rejection propagates to the caller");
  }

  console.log("\n================================================================");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("================================================================");

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
