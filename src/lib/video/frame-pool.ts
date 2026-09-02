/**
 * Pool of identical headless-Chromium render pages.
 *
 * The legacy video renderer used one page for every output frame. Encoding
 * overlaps badly with the per-frame browser round-trip, so frames are now
 * rendered by N interchangeable pages and handed to the encoder through
 * OrderedFramePipeline (out-of-order rendering, in-order writing). Each page
 * runs at most one render at a time — they share nothing, but the canvas
 * inside each one is stateful.
 */
import type { Page } from "playwright";
import { getBrowser } from "@/lib/render/render-image";

export interface FrameRenderPool {
  readonly size: number;
  renderFrame(frameIdx: number, workerId: number): Promise<Buffer>;
  close(): Promise<void>;
}

export async function createFrameRenderPool(params: {
  size: number;
  /** Make a fresh page render-ready (load the design, fonts, globals). */
  setupPage: (page: Page) => Promise<void>;
  /** Render one frame on one page. Called with ≤1 in-flight call per page. */
  renderOnPage: (page: Page, frameIdx: number) => Promise<Buffer>;
  timeoutMs: number;
}): Promise<FrameRenderPool> {
  const browser = await getBrowser();
  const pages: Page[] = [];
  try {
    for (let i = 0; i < params.size; i += 1) {
      const page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(params.timeoutMs);
      pages.push(page);
    }
    await Promise.all(pages.map((page) => params.setupPage(page)));

    return {
      size: pages.length,
      async renderFrame(frameIdx: number, workerId: number) {
        const page = pages[workerId % pages.length];
        return params.renderOnPage(page, frameIdx);
      },
      async close() {
        await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
      },
    };
  } catch (error) {
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    throw error;
  }
}
