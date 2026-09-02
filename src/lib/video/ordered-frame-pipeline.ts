/**
 * Ordered frame pipeline with back-pressure.
 *
 * Frames are PRODUCED out of order by `workerCount` workers (e.g. parallel
 * Playwright pages) but must reach the encoder IN frame order. Workers pull
 * the next frame index as soon as they go idle; finished frames wait in a
 * small reorder buffer; the consumer always awaits `nextToConsume` before
 * more work is scheduled past it. `maxBuffered` bounds how many completed
 * frames may pile up ahead of the consumer, so memory stays at roughly
 * maxBuffered × frame-size no matter how skewed worker speeds are.
 */
export interface OrderedFramePipelineOptions<T> {
  /** Parallel producers (each handles one frame at a time). */
  workerCount: number;
  /** Render one frame. Must be safe to call concurrently from the pool. */
  produce: (frameIdx: number, workerId: number) => Promise<T>;
  /** Write one finished frame, in strict frame order. */
  consume: (frame: T, frameIdx: number) => Promise<void>;
  /** Max frames completed-but-not-yet-consumed. Default workerCount × 2. */
  maxBuffered?: number;
}

export class OrderedFramePipeline<T> {
  private nextToProduce = 0;
  private nextToConsume = 0;
  private readonly results = new Map<number, Promise<T>>();
  private idleWorkers: number[] = [];

  constructor(private readonly opts: OrderedFramePipelineOptions<T>) {}

  async run(frameCount: number): Promise<void> {
    if (frameCount <= 0) return;
    this.idleWorkers = Array.from(
      { length: Math.max(1, Math.min(this.opts.workerCount, frameCount)) },
      (_, i) => i
    );

    for (;;) {
      this.fill(frameCount);
      if (this.nextToConsume >= frameCount) break;
      const pending = this.results.get(this.nextToConsume);
      if (!pending) {
        // fill() guarantees this cannot happen (an idle worker or buffer
        // slot is always available for the next needed frame).
        throw new Error(`OrderedFramePipeline: frame ${this.nextToConsume} was never produced`);
      }
      const frame = await pending;
      this.results.delete(this.nextToConsume);
      await this.opts.consume(frame, this.nextToConsume);
      this.nextToConsume += 1;
    }
  }

  /** Highest number of frames that were completed-but-unconsumed at once. */
  get bufferedHighWaterMark(): number {
    return this.results.size;
  }

  private fill(frameCount: number): void {
    const cap = Math.max(1, this.opts.maxBuffered ?? this.opts.workerCount * 2);
    while (this.nextToProduce < frameCount && this.idleWorkers.length > 0 && this.results.size < cap) {
      const frameIdx = this.nextToProduce;
      const workerId = this.idleWorkers.pop()!;
      this.nextToProduce += 1;
      const pending = this.opts.produce(frameIdx, workerId).finally(() => {
        this.idleWorkers.push(workerId);
      });
      // A rejection must not become an unhandledRejection while the frame
      // sits in the buffer waiting for its turn — the consumer's `await`
      // still sees the original rejection.
      pending.catch(() => undefined);
      this.results.set(frameIdx, pending);
    }
  }
}
