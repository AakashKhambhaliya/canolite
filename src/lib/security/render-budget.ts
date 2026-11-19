import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "@/lib/config";

/** Count whole pipelines, including downloads, not just open browser pages. */
export class BoundedGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number, private readonly backlog: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.backlog) throw new Error("Render capacity is full; retry later");
      await new Promise<void>(r => this.waiting.push(r));
    } else this.active++;
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); // transfer the existing permit without a free-slot race
      else this.active--;
    }
  }
}
type Lease = {signal: AbortSignal};
const shared = globalThis as typeof globalThis & { __canoliteLimits?: {all: BoundedGate; video: BoundedGate; project: AsyncLocalStorage<string>; lease: AsyncLocalStorage<Lease>} };
const limits = shared.__canoliteLimits ??= { all: new BoundedGate(Math.max(1, config.RENDER_CONCURRENCY), 64), video: new BoundedGate(Math.max(1, config.VIDEO_CONCURRENCY), 32), project: new AsyncLocalStorage<string>(), lease: new AsyncLocalStorage<Lease>() };
export const renderProject = () => limits.project.getStore();
export const withMediaProject = <T>(id:string, fn:()=>Promise<T>) => limits.project.run(id,fn);
export const renderSignal = () => limits.lease.getStore()?.signal;

export async function withDeadline<T>(ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Render timed out")), ms);
  try {
    const value = await operation(controller.signal); // wait through actual teardown, even on abort
    controller.signal.throwIfAborted();
    return value;
  } catch (error) { controller.signal.throwIfAborted(); throw error; }
  finally { clearTimeout(timer); controller.abort(); }
}
export function withRenderSlot<T>(fn: () => Promise<T>, kind: "image" | "video" = "image"): Promise<T> {
  const inherited = renderSignal();
  if (inherited) { inherited.throwIfAborted(); return fn(); }
  const run = () => limits.all.run(() => withDeadline(kind === "video" ? config.VIDEO_RENDER_TIMEOUT_MS : config.RENDER_TIMEOUT_MS,
    signal => limits.lease.run({signal}, fn)));
  return kind === "video" ? limits.video.run(run) : run();
}
