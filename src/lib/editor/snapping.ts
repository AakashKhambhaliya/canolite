/**
 * Snapping + alignment guides for the Fabric editor (Photoshop-style).
 *
 * While an object is dragged, its edges and center snap to:
 *   - Canvas edges and center
 *   - Other objects' edges and centers
 *
 * Guides are only visible while an object is actively snapping and disappear
 * as soon as the drag ends or the object is deselected.
 */
const SNAP_THRESHOLD = 24; // screen pixels – strong snapping

interface Guide {
  axis: "x" | "y";
  pos: number; // canvas-space coordinate
}

export function installSnapping(canvas: any): () => void {
  let guides: Guide[] = [];
  let isDragging = false;

  const threshold = () => SNAP_THRESHOLD / (canvas.getZoom?.() || 1);

  // canvas.width/height are the *current on-screen pixel size* — this app's
  // zoom effect resizes the canvas element itself (setDimensions) alongside
  // setZoom, so at anything other than exactly 100% native zoom they're
  // smaller/larger than the template's actual design size. Object
  // coordinates (obj.left/top below) stay in that fixed design space
  // regardless of zoom, so dividing back out by the current zoom recovers
  // it — the same design size setZoom/setDimensions was originally given.
  function designSize() {
    const z = canvas.getZoom?.() || 1;
    const w = (canvas.width || 1080) / z;
    const h = (canvas.height || 1350) / z;
    return { w, h };
  }

  /**
   * Get the bounding box of an object using its direct properties.
   * Uses obj.left/top, which are in the canvas's fixed design-space
   * coordinates (see designSize() above) — not canvas.width/height.
   */
  function bounds(obj: any) {
    const l = obj.left || 0;
    const t = obj.top || 0;
    // ?? not ||: a scale of 0 is a real (degenerate) size, not "unset".
    const w = (obj.width || 0) * (obj.scaleX ?? 1);
    const h = (obj.height || 0) * (obj.scaleY ?? 1);
    return {
      left: l,
      right: l + w,
      cx: l + w / 2,
      top: t,
      bottom: t + h,
      cy: t + h / 2,
    };
  }

  // Pick the nearest snap target within threshold for a set of object anchors.
  function bestSnap(anchors: number[], targets: number[], t: number) {
    let best: { delta: number; pos: number; dist: number } | null = null;
    for (const val of anchors) {
      for (const target of targets) {
        const dist = Math.abs(val - target);
        if (dist <= t && (!best || dist < best.dist)) {
          best = { delta: target - val, pos: target, dist };
        }
      }
    }
    return best;
  }

  function onMoving(e: any) {
    const obj = e.target;
    if (!obj) return;
    isDragging = true;
    guides = [];
    const t = threshold();

    // Canvas dimensions, in the same design-space coordinates as obj.left/top
    const { w, h } = designSize();

    // Snap to canvas edges + center
    const xTargets = [0, w / 2, w];
    const yTargets = [0, h / 2, h];

    const b = bounds(obj);

    const snapX = bestSnap([b.left, b.cx, b.right], xTargets, t);
    if (snapX) {
      obj.left += snapX.delta;
      // Show a guide for every snap (edges and corners included, not just
      // center) so snapping to a canvas corner is visibly confirmed.
      guides.push({ axis: "x", pos: snapX.pos });
    }

    const snapY = bestSnap([b.top, b.cy, b.bottom], yTargets, t);
    if (snapY) {
      obj.top += snapY.delta;
      guides.push({ axis: "y", pos: snapY.pos });
    }

    obj.setCoords();
  }

  function onScaling(e: any) {
    const obj = e.target;
    if (!obj) return;
    isDragging = true;
    guides = [];
    const t = threshold();

    const { w, h } = designSize();

    const xTargets = [0, w / 2, w];
    const yTargets = [0, h / 2, h];

    const b = bounds(obj);

    // Snap right edge
    let snapRight = bestSnap([b.right], xTargets, t);
    // A snap that would collapse the object to (or past) zero size is
    // ignored: it wrote scaleX/scaleY <= 0, which later divided by zero in
    // the inspector and serialized NaN/Infinity into the design.
    const MIN_SNAP_SIZE = 1;
    if (snapRight && snapRight.pos - b.left < MIN_SNAP_SIZE) snapRight = null;
    if (snapRight) {
      const newW = snapRight.pos - b.left;
      obj.scaleX = newW / (obj.width || 1);
      guides.push({ axis: "x", pos: snapRight.pos });
    }

    // Snap bottom edge
    let snapBottom = bestSnap([b.bottom], yTargets, t);
    if (snapBottom && snapBottom.pos - b.top < MIN_SNAP_SIZE) snapBottom = null;
    if (snapBottom) {
      const newH = snapBottom.pos - b.top;
      obj.scaleY = newH / (obj.height || 1);
      guides.push({ axis: "y", pos: snapBottom.pos });
    }

    // Snap left edge (when dragging from left handle). Unlike the right/
    // bottom cases above, this one has to move `obj.left` too — dragging
    // the left handle changes *both* position and size (the right edge
    // stays anchored while the left edge follows the cursor), so snapping
    // only the width here left `left` wherever the raw drag put it, short
    // of the target. That's what made left/top snapping show a guide line
    // without the edge actually reaching it, unlike the right/bottom
    // handles — the object never physically got there.
    const snapLeft = bestSnap([b.left], xTargets, t);
    if (snapLeft && !snapRight && b.right - snapLeft.pos >= MIN_SNAP_SIZE) {
      const newW = b.right - snapLeft.pos;
      obj.scaleX = newW / (obj.width || 1);
      obj.left = snapLeft.pos;
      guides.push({ axis: "x", pos: snapLeft.pos });
    }

    // Snap top edge (when dragging from top handle) — same reasoning as left.
    const snapTop = bestSnap([b.top], yTargets, t);
    if (snapTop && !snapBottom && b.bottom - snapTop.pos >= MIN_SNAP_SIZE) {
      const newH = b.bottom - snapTop.pos;
      obj.scaleY = newH / (obj.height || 1);
      obj.top = snapTop.pos;
      guides.push({ axis: "y", pos: snapTop.pos });
    }

    obj.setCoords();
  }

  // Clears contextTop every frame regardless of drag state, rather than
  // drawing guides incrementally and relying on whichever event ended the
  // drag to explicitly erase the old frame. Fabric only clears contextTop
  // itself when its own `contextTopDirty` flag is set (e.g. a blinking text
  // cursor) — it does *not* do that for us on every render — so a guide
  // drawn on one frame stays put until something erases it. That made stray
  // guide lines freeze on screen whenever a drag ended through a path that
  // skipped the manual clear once used here (e.g. deleting the object
  // mid-drag). Clearing unconditionally up front avoids depending on which
  // event fires.
  function onAfterRender() {
    const ctx = canvas.contextTop;
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    if (!guides.length || !isDragging) return;

    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const { w: W, h: H } = designSize();
    const canvasW = W * vpt[0];
    const canvasH = H * vpt[3];

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = canvas.selectionBorderColor;
    ctx.setLineDash([4, 3]);
    for (const g of guides) {
      ctx.beginPath();
      if (g.axis === "x") {
        const x = Math.round(g.pos * vpt[0] + vpt[4]) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasH + vpt[5] * 2);
      } else {
        const y = Math.round(g.pos * vpt[3] + vpt[5]) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(canvasW + vpt[4] * 2, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function clearGuides() {
    isDragging = false;
    if (guides.length) {
      guides = [];
      canvas.requestRenderAll();
    }
  }

  canvas.on("object:moving", onMoving);
  canvas.on("object:scaling", onScaling);
  canvas.on("after:render", onAfterRender);
  canvas.on("mouse:up", clearGuides);
  canvas.on("object:modified", clearGuides);
  canvas.on("selection:cleared", clearGuides);
  // Deleting the object being dragged (e.g. pressing Delete mid-drag) skips
  // mouse:up entirely, which otherwise left a stale guide line frozen on
  // screen at the object's last position forever.
  canvas.on("object:removed", clearGuides);

  return () => {
    canvas.off("object:moving", onMoving);
    canvas.off("object:scaling", onScaling);
    canvas.off("after:render", onAfterRender);
    canvas.off("mouse:up", clearGuides);
    canvas.off("object:modified", clearGuides);
    canvas.off("selection:cleared", clearGuides);
    canvas.off("object:removed", clearGuides);
  };
}
