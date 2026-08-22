/**
 * In-canvas video playback for the editor.
 *
 * A video layer is a Fabric image showing the poster frame that ffmpeg pulled
 * out of the clip at upload time. That is all the editor ever painted, so the
 * only way to see what a template's video actually did was to run a full MP4
 * render and watch the result. This drives the real clips on the editor canvas
 * instead, on the same timeline the renderer uses.
 *
 * ## Why this never touches the Fabric object's state
 *
 * The obvious implementation — `obj.setElement(videoEl)` — corrupts the saved
 * design. `FabricImage.toObject()` serializes `src` from `_originalElement`,
 * so once a <video> is installed the template saves with `src` pointing at the
 * MP4. The editor would then try to load an MP4 as an image on reopen, and the
 * server render would do the same.
 *
 * So playback happens entirely through an override of `_renderFill`, the one
 * method that puts pixels on the canvas. `_element` / `_originalElement` are
 * left alone, which means `toObject()` keeps emitting the poster URL and save,
 * undo and export are all unaffected by whether a preview is running. Nothing
 * else the object owns is mutated either — a layer that is off-timeline draws
 * nothing rather than having its `opacity` or `visible` set, because both of
 * those ARE serialized and a mid-preview save would have persisted them.
 *
 * `objectCaching` is the sole exception; Fabric does not serialize it.
 *
 * ## Timeline
 *
 * The mapping from timeline time to source time mirrors `sourceTimeForFrame`
 * in lib/video/timeline.ts exactly — same trim window, same `startAt` offset,
 * same loop wrap, same playbackRate — so what plays here is what encodes.
 * Each <video> runs on its own native clock (seeking every frame stutters);
 * the loop below only corrects it when it drifts out of tolerance, which is
 * also what wraps a looping clip back to its trim start.
 */

/** How far a video element may drift from the timeline before we re-seek. */
const DRIFT_TOLERANCE_SEC = 0.15;

/** Chromium refuses playbackRate outside roughly this range. */
const MIN_PLAYBACK_RATE = 0.0625;
const MAX_PLAYBACK_RATE = 16;

/**
 * How often the position may be pushed to the subscriber while playing.
 *
 * The canvas repaints from requestAnimationFrame regardless of this, so the
 * video itself always runs at full frame rate. This throttles only the React
 * state update behind the transport bar — re-rendering the whole editor tree
 * 60 times a second to move a progress handle a few pixels is what made the
 * first version of this stutter. A 10 Hz readout is visually smooth.
 */
const STATE_EMIT_INTERVAL_MS = 100;

/**
 * Shortest preview timeline, matching `buildTimeline`'s `Math.max(5, ...)`.
 * A 2-second clip really does encode to a 5-second MP4, and a preview that
 * quietly disagreed with the export would defeat the point.
 */
const MIN_TIMELINE_SEC = 5;

export interface VideoPreviewState {
  /** A preview is running (as opposed to paused or stopped). */
  playing: boolean;
  /** Position on the preview timeline, in seconds. */
  time: number;
  /** Length of the current preview timeline, in seconds. */
  duration: number;
  /** Layer id when previewing a single clip, null when previewing the composition. */
  soloLayerId: string | null;
  /** True once at least one clip has decoded enough to paint. */
  ready: boolean;
}

interface PreviewLayer {
  /** The Fabric object being painted. */
  obj: any;
  id: string;
  videoSrc: string;
  trimStart: number;
  trimEnd: number;
  startAt: number;
  loop: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  fit: "cover" | "contain" | "stretch";
  el: HTMLVideoElement;
  /** The `_renderFill` this object drew with before we overrode it. */
  originalRenderFill: any;
  /**
   * Whether that came from the object ITSELF rather than its prototype.
   * Teardown has to delete our override in the prototype case: assigning the
   * inherited method back would leave a permanent own property shadowing the
   * prototype, so the object would never pick up a later Fabric change.
   */
  renderFillWasOwn: boolean;
  originalObjectCaching: boolean;
  /** Source time this layer should be showing, or null when off-timeline. */
  sourceTime: number | null;
}

function num(value: unknown, fallback: number, min = -Infinity): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Every video layer currently on the canvas, in stacking order. */
export function collectVideoObjects(canvas: any): any[] {
  if (!canvas) return [];
  const out: any[] = [];
  const walk = (objects: any[]) => {
    for (const obj of objects || []) {
      if (
        String(obj?.type || "").toLowerCase() === "image" &&
        obj.mediaType === "video" &&
        obj.videoSrc
      ) {
        out.push(obj);
      }
      if (Array.isArray(obj?._objects)) walk(obj._objects);
    }
  };
  walk(canvas.getObjects());
  return out;
}

/**
 * Where the playhead sits after `elapsed` seconds of wall time, and whether it
 * wrapped past the end of the timeline on the way.
 *
 * `clockOrigin` is the timeline position the clock was last based at (a fresh
 * play, a resume, a seek, or the previous wrap) — NOT the start of the
 * timeline. `timelineStart` is the start, which is 0 for a composed preview
 * and the layer's `startAt` when previewing one clip solo, and it is where a
 * wrap rewinds to.
 *
 * Split out as a pure function because collapsing those two into one value is
 * exactly the mistake that made resume restart from the beginning and made a
 * seek near the end thrash instead of looping.
 */
export function advancePlayhead(
  clockOrigin: number,
  elapsed: number,
  timelineStart: number,
  duration: number
): { time: number; wrapped: boolean } {
  const t = clockOrigin + elapsed;
  if (duration > timelineStart && t >= duration) {
    return { time: timelineStart, wrapped: true };
  }
  return { time: t, wrapped: false };
}

/** The timing fields `sourceTimeAt` needs — a subset of a `PreviewLayer`. */
export interface PreviewTiming {
  trimStart: number;
  trimEnd: number;
  startAt: number;
  loop: boolean;
  playbackRate: number;
}

/** Every playback setting the properties panel can change on a video layer. */
export interface PreviewSettings extends PreviewTiming {
  muted: boolean;
  volume: number;
  fit: "cover" | "contain" | "stretch";
}

/**
 * Read a video layer's playback settings off the Fabric object.
 *
 * Deliberately one definition rather than two: these are read when a preview
 * starts AND re-read on every frame while it runs, because the trim, rate and
 * audio controls sit directly under the play button — adjusting Trim start
 * mid-preview has to move the playhead, not wait for a stop-and-replay.
 */
export function readPreviewSettings(obj: any): PreviewSettings {
  const duration = num(obj.videoDuration, 0, 0);
  const trimStart = num(obj.trimStart, 0, 0);
  const rawTrimEnd = obj.trimEnd === undefined ? duration : Number(obj.trimEnd);
  return {
    trimStart,
    trimEnd: Math.max(
      trimStart,
      Number.isFinite(rawTrimEnd) ? rawTrimEnd : duration
    ),
    startAt: num(obj.startAt, 0, 0),
    loop: obj.loop !== false,
    muted: obj.muted === true,
    volume: num(obj.volume, 1, 0),
    playbackRate: clamp(
      num(obj.playbackRate, 1, 0.0001),
      MIN_PLAYBACK_RATE,
      MAX_PLAYBACK_RATE
    ),
    fit: obj.fit === "contain" || obj.fit === "stretch" ? obj.fit : "cover",
  };
}

/**
 * Where in the source clip a layer should be at timeline time `t`, or null
 * when the layer isn't on screen then (before its `startAt`, or past the end
 * of a non-looping clip). Deliberately identical to `sourceTimeForFrame` in
 * lib/video/timeline.ts — if these two ever disagree, the preview lies about
 * what the export will contain. Exported so a test can hold them to that.
 */
export function sourceTimeAt(layer: PreviewTiming, t: number): number | null {
  if (t < layer.startAt) return null;
  const span = layer.trimEnd - layer.trimStart;
  if (span <= 0) return null;
  const layerTime = (t - layer.startAt) * layer.playbackRate;
  if (!layer.loop && layerTime > span) return null;
  const offset = layer.loop ? layerTime % span : Math.min(layerTime, span);
  return layer.trimStart + offset;
}

export interface FitRects {
  /** Source rectangle to sample from the frame. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rectangle, in the object's local (centre-origin) space. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** True when the destination doesn't fill the box and needs letterboxing. */
  letterbox: boolean;
}

/**
 * Source and destination rectangles for painting a frame into a layer's box,
 * using the same fit rule ffmpeg applies when it decodes frames for the render
 * (see buildFrameDecodeArgs): `cover` crops the overflow, `contain`
 * letterboxes on black, `stretch` distorts.
 *
 * `cover` crops in SOURCE space rather than clipping the destination, so no
 * save/restore or clip path is needed on every animation frame.
 *
 * Pure and exported so the geometry can be tested without a canvas.
 */
export function fitRects(
  videoW: number,
  videoH: number,
  boxW: number,
  boxH: number,
  fit: "cover" | "contain" | "stretch"
): FitRects {
  const dx = -boxW / 2;
  const dy = -boxH / 2;

  if (fit === "stretch") {
    return { sx: 0, sy: 0, sw: videoW, sh: videoH, dx, dy, dw: boxW, dh: boxH, letterbox: false };
  }

  if (fit === "contain") {
    const scale = Math.min(boxW / videoW, boxH / videoH);
    const dw = videoW * scale;
    const dh = videoH * scale;
    return {
      sx: 0,
      sy: 0,
      sw: videoW,
      sh: videoH,
      dx: dx + (boxW - dw) / 2,
      dy: dy + (boxH - dh) / 2,
      dw,
      dh,
      letterbox: dw < boxW || dh < boxH,
    };
  }

  const sw = Math.min(videoW, (videoH * boxW) / boxH);
  const sh = Math.min(videoH, (videoW * boxH) / boxW);
  return {
    sx: (videoW - sw) / 2,
    sy: (videoH - sh) / 2,
    sw,
    sh,
    dx,
    dy,
    dw: boxW,
    dh: boxH,
    letterbox: false,
  };
}

/**
 * Paint a video frame into the layer's box. Coordinates are the object's local
 * space with the origin at its centre — which is where Fabric has already put
 * the context by the time this runs.
 */
function drawFitted(
  ctx: CanvasRenderingContext2D,
  el: HTMLVideoElement,
  boxW: number,
  boxH: number,
  fit: "cover" | "contain" | "stretch"
): void {
  const vw = el.videoWidth;
  const vh = el.videoHeight;
  if (!vw || !vh || boxW <= 0 || boxH <= 0) return;

  const r = fitRects(vw, vh, boxW, boxH, fit);
  if (r.letterbox) {
    ctx.fillStyle = "#000";
    ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  }
  ctx.drawImage(el, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
}

export class VideoPreview {
  private canvas: any;
  private onState: (state: VideoPreviewState) => void;
  private onAudioBlocked: (() => void) | null;

  private layers: PreviewLayer[] = [];
  private raf: number | null = null;
  /**
   * Where this run's timeline BEGINS, fixed for the whole run: 0 when
   * previewing the composition, the layer's `startAt` when previewing one clip
   * solo. This is the floor for seeking and the target the loop rewinds to.
   */
  private timelineStart = 0;
  /**
   * The clock's reference point: `clockOrigin` is the timeline position at
   * wall-clock time `clockStart`, so the current position is
   * `clockOrigin + (now - clockStart)`. Rewritten by every seek, resume and
   * loop wrap.
   *
   * Kept separate from `timelineStart` on purpose. One value serving both
   * roles is subtly wrong in two ways: resuming from a pause restarted the
   * timeline from its beginning instead of continuing (the clock was re-based
   * without moving its origin to the paused position), and after a seek the
   * end-of-timeline wrap rewound to the SEEK point rather than the start —
   * so a seek near the end left playback thrashing against the end instead of
   * looping.
   */
  private clockStart = 0;
  private clockOrigin = 0;
  private time = 0;
  private duration = 0;
  private playing = false;
  private soloLayerId: string | null = null;
  private ready = false;
  private audioBlockedReported = false;
  private disposed = false;
  private lastEmitAt = 0;

  constructor(
    canvas: any,
    onState: (state: VideoPreviewState) => void,
    onAudioBlocked?: () => void
  ) {
    this.canvas = canvas;
    this.onState = onState;
    this.onAudioBlocked = onAudioBlocked || null;
  }

  getState(): VideoPreviewState {
    return {
      playing: this.playing,
      time: this.time,
      duration: this.duration,
      soloLayerId: this.soloLayerId,
      ready: this.ready,
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.lastEmitAt = performance.now();
    this.onState(this.getState());
  }

  /** Position update from the animation loop — rate-limited, see the constant. */
  private emitProgress(): void {
    if (performance.now() - this.lastEmitAt < STATE_EMIT_INTERVAL_MS) return;
    this.emit();
  }

  /** Objects that this preview run should drive. */
  private targets(): any[] {
    const all = collectVideoObjects(this.canvas);
    if (!this.soloLayerId) return all;
    return all.filter((obj) => this.layerId(obj) === this.soloLayerId);
  }

  private layerId(obj: any): string {
    return obj.id || obj.name || "";
  }

  /**
   * Build the per-layer playback state and install the render override.
   * Called at the start of a run; `teardown()` reverses every part of it.
   */
  private setup(objects: any[]): void {
    this.layers = objects.map((obj) => {
      const el = document.createElement("video");
      // /storage answers with Access-Control-Allow-Origin: *, so requesting
      // CORS keeps drawImage() from tainting the editor canvas.
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.playsInline = true;
      el.muted = obj.muted === true;
      // HTMLMediaElement.volume tops out at 1. The properties panel allows up
      // to 200% because ffmpeg can amplify on the real render; the preview
      // simply plays such a layer at full volume.
      el.volume = clamp(num(obj.volume, 1, 0), 0, 1);
      el.src = obj.videoSrc;
      el.load();

      const settings = readPreviewSettings(obj);
      el.playbackRate = settings.playbackRate;

      const layer: PreviewLayer = {
        obj,
        id: this.layerId(obj),
        videoSrc: obj.videoSrc,
        ...settings,
        el,
        originalRenderFill: obj._renderFill,
        renderFillWasOwn: Object.prototype.hasOwnProperty.call(obj, "_renderFill"),
        originalObjectCaching: obj.objectCaching,
        sourceTime: null,
      };

      // Fabric would otherwise paint a cached bitmap of the poster and never
      // call through to the override below.
      obj.objectCaching = false;
      obj.dirty = true;
      obj._renderFill = function (this: any, ctx: CanvasRenderingContext2D) {
        // Off-timeline: draw nothing. This is the one case where the renderer
        // shows an empty box, and it must NOT be expressed by touching
        // `opacity` or `visible`, which would be saved into the design.
        if (layer.sourceTime === null) return;
        // Still buffering — the poster is the honest thing to show.
        if (layer.el.readyState < 2 || !layer.el.videoWidth) {
          return layer.originalRenderFill.call(this, ctx);
        }
        drawFitted(ctx, layer.el, this.width, this.height, layer.fit);
      };

      return layer;
    });
  }

  /** Undo everything `setup()` did and release the video elements. */
  private teardown(): void {
    for (const layer of this.layers) {
      if (layer.renderFillWasOwn) layer.obj._renderFill = layer.originalRenderFill;
      else delete layer.obj._renderFill;
      layer.obj.objectCaching = layer.originalObjectCaching;
      layer.obj.dirty = true;
      layer.el.pause();
      // Drop the buffered data instead of leaving the element (and its network
      // stream) alive for the rest of the editing session.
      layer.el.removeAttribute("src");
      layer.el.load();
    }
    this.layers = [];
    this.canvas?.requestRenderAll();
  }

  /** Preview length: the composed timeline, or just the solo clip's span. */
  private computeDuration(): number {
    if (this.layers.length === 0) return 0;
    const ends = this.layers.map((layer) => {
      const span = Math.max(0, layer.trimEnd - layer.trimStart);
      return layer.startAt + span / layer.playbackRate;
    });
    if (this.soloLayerId) return Math.max(...ends);
    return Math.max(MIN_TIMELINE_SEC, ...ends);
  }

  /** True when there is anything at all to preview. */
  hasVideo(): boolean {
    return collectVideoObjects(this.canvas).length > 0;
  }

  /**
   * Start (or resume) playback.
   *
   * `soloLayerId` previews one clip on its own; its timeline starts at that
   * layer's `startAt` so playback begins on the first trimmed frame instead of
   * on however many seconds of empty canvas precede it. Omit it to preview the
   * whole composition from t = 0, exactly as it will encode.
   */
  play(soloLayerId?: string | null): void {
    if (this.disposed) return;

    const solo = soloLayerId ?? null;
    // Switching between solo and composed (or between two clips) restarts.
    if (this.layers.length > 0 && solo !== this.soloLayerId) this.stop();

    if (this.layers.length === 0) {
      this.soloLayerId = solo;
      const objects = this.targets();
      if (objects.length === 0) return;
      this.setup(objects);
      this.duration = this.computeDuration();
      this.timelineStart = solo ? this.layers[0].startAt : 0;
      this.time = this.timelineStart;
      this.ready = false;
    }

    this.playing = true;
    // Re-base the clock on wherever the timeline currently sits. On a fresh
    // start that is `timelineStart`; on a resume it is the paused position,
    // which is what makes the clip carry on rather than start over.
    this.clockOrigin = this.time;
    this.clockStart = performance.now();
    this.emit();
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    for (const layer of this.layers) layer.el.pause();
    this.emit();
  }

  /** Stop and put every layer back on its poster frame. */
  stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.playing = false;
    this.teardown();
    this.time = 0;
    this.duration = 0;
    this.timelineStart = 0;
    this.clockOrigin = 0;
    this.soloLayerId = null;
    this.ready = false;
    this.emit();
  }

  /** Jump to a point on the current timeline (only valid mid-preview). */
  seek(time: number): void {
    if (this.layers.length === 0) return;
    // Pick up any pending panel edits first, so the seek is clamped against
    // the timeline the user is actually looking at.
    this.syncSettings();
    this.time = clamp(time, this.timelineStart, this.duration);
    this.clockOrigin = this.time;
    this.clockStart = performance.now();
    this.applyFrame(this.time, { forceSeek: true });
    this.canvas?.requestRenderAll();
    this.emit();
  }

  /**
   * Point every layer at the source time `t` implies.
   *
   * The element runs on its own clock between calls; we only re-seek when it
   * has drifted past the tolerance, which is also what snaps a looping clip
   * back to its trim start when the modulo wraps.
   */
  /**
   * Pull each layer's playback settings back off its Fabric object.
   *
   * The trim, Start at, fit, loop and audio controls sit directly beneath the
   * play button, so they are routinely adjusted with a preview already
   * running. Re-reading them every frame is what makes those edits land
   * immediately instead of waiting for a stop-and-replay — the settings are a
   * handful of plain properties, so this is far cheaper than the repaint it
   * accompanies.
   *
   * Trim, Start at and rate also change how long the timeline is, so the
   * duration (and, when previewing one clip solo, where its timeline begins)
   * are re-derived here too.
   */
  private syncSettings(): void {
    if (this.layers.length === 0) return;

    let changed = false;
    for (const layer of this.layers) {
      const next = readPreviewSettings(layer.obj);
      if (next.muted !== layer.muted) layer.el.muted = next.muted;
      if (next.volume !== layer.volume) {
        layer.el.volume = clamp(next.volume, 0, 1);
      }
      if (next.playbackRate !== layer.playbackRate) {
        layer.el.playbackRate = next.playbackRate;
      }
      if (
        next.trimStart !== layer.trimStart ||
        next.trimEnd !== layer.trimEnd ||
        next.startAt !== layer.startAt ||
        next.playbackRate !== layer.playbackRate
      ) {
        changed = true;
      }
      Object.assign(layer, next);
    }
    if (!changed) return;

    const duration = this.computeDuration();
    // Solo previews begin at the clip's own `startAt`, which the panel can
    // move while this is playing.
    const timelineStart = this.soloLayerId ? this.layers[0].startAt : 0;
    if (duration === this.duration && timelineStart === this.timelineStart) return;

    this.duration = duration;
    this.timelineStart = timelineStart;
    // Re-base the clock so a shortened timeline doesn't leave the playhead
    // stranded past its own end (or before its new start).
    this.time = clamp(this.time, timelineStart, Math.max(timelineStart, duration));
    this.clockOrigin = this.time;
    this.clockStart = performance.now();
    this.emit();
  }

  private applyFrame(t: number, opts: { forceSeek?: boolean } = {}): void {
    let anyReady = false;

    for (const layer of this.layers) {
      const target = sourceTimeAt(layer, t);
      layer.sourceTime = target;
      layer.obj.dirty = true;

      if (target === null) {
        if (!layer.el.paused) layer.el.pause();
        continue;
      }

      if (layer.el.readyState >= 2 && layer.el.videoWidth) anyReady = true;

      if (
        opts.forceSeek ||
        !Number.isFinite(layer.el.currentTime) ||
        Math.abs(layer.el.currentTime - target) > DRIFT_TOLERANCE_SEC
      ) {
        try {
          layer.el.currentTime = target;
        } catch {
          // Seeking before metadata arrives throws; the next frame retries.
        }
      }

      if (this.playing && layer.el.paused) this.startElement(layer);
      if (!this.playing && !layer.el.paused) layer.el.pause();
    }

    if (anyReady && !this.ready) {
      this.ready = true;
      this.emit();
    }
  }

  /**
   * Start one element, downgrading to muted if the browser blocks audible
   * playback. Chromium rejects `play()` with NotAllowedError when a page
   * hasn't earned autoplay permission; muting always satisfies the policy, so
   * the preview keeps working and the operator is told why it went silent.
   */
  private startElement(layer: PreviewLayer): void {
    const attempt = layer.el.play();
    if (!attempt || typeof attempt.catch !== "function") return;
    attempt.catch((err: any) => {
      if (this.disposed || err?.name !== "NotAllowedError" || layer.el.muted) return;
      layer.el.muted = true;
      layer.el.play().catch(() => undefined);
      if (!this.audioBlockedReported) {
        this.audioBlockedReported = true;
        this.onAudioBlocked?.();
      }
    });
  }

  private tick = (): void => {
    if (this.disposed || !this.playing) return;

    // Before reading the clock, not after: this can re-base it when a panel
    // edit changed how long the timeline is.
    this.syncSettings();

    const now = performance.now();
    // Loop the whole preview rather than stopping dead on the last frame,
    // which would mean re-clicking play for every look.
    const { time: t, wrapped } = advancePlayhead(
      this.clockOrigin,
      (now - this.clockStart) / 1000,
      this.timelineStart,
      this.duration
    );
    if (wrapped) {
      this.clockOrigin = this.timelineStart;
      this.clockStart = now;
    }

    this.time = t;
    this.applyFrame(t);
    this.canvas?.requestRenderAll();
    this.emitProgress();
    this.raf = requestAnimationFrame(this.tick);
  };

  /**
   * Release everything. Safe to call more than once, and safe to call when a
   * preview was never started.
   */
  dispose(): void {
    if (this.disposed) return;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.playing = false;
    this.teardown();
    this.disposed = true;
  }
}
