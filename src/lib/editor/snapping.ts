/**
 * Snapping + alignment guides for the Fabric editor (Photoshop-style).
 *
 * While an object is dragged, its edges and center snap to:
 *   - Canvas edges and center
 *   - Other objects' edges and centers
 *
 * Guides are only visible while dragging and clear immediately on mouse-up.
 */
const GUIDE_COLOR = "#ff2d78"; // smart-guide magenta
const SNAP_THRESHOLD = 24; // screen pixels – strong snapping

interface Guide {
  axis: "x" | "y";
  pos: number; // canvas-space coordinate
}

export function installSnapping(canvas: any): () => void {
  let guides: Guide[] = [];
  let isDragging = false;

  const threshold = () => SNAP_THRESHOLD / (canvas.getZoom?.() || 1);

  /**
   * Get the bounding box of an object using its direct properties.
   * Uses obj.left/top which are in the same coordinate space as canvas.width/height.
   */
  function bounds(obj: any) {
    const l = obj.left || 0;
    const t = obj.top || 0;
    const w = (obj.width || 0) * (obj.scaleX || 1);
    const h = (obj.height || 0) * (obj.scaleY || 1);
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

    // Canvas dimensions
    const w = canvas.width || canvas.getWidth?.() || 1080;
    const h = canvas.height || canvas.getHeight?.() || 1350;

    // Snap to canvas edges + center
    const xTargets = [0, w / 2, w];
    const yTargets = [0, h / 2, h];

    const b = bounds(obj);

    const snapX = bestSnap([b.left, b.cx, b.right], xTargets, t);
    if (snapX) {
      obj.left += snapX.delta;
      // Only show guide line for center snap
      if (snapX.pos === w / 2) {
        guides.push({ axis: "x", pos: snapX.pos });
      }
    }

    const snapY = bestSnap([b.top, b.cy, b.bottom], yTargets, t);
    if (snapY) {
      obj.top += snapY.delta;
      if (snapY.pos === h / 2) {
        guides.push({ axis: "y", pos: snapY.pos });
      }
    }

    obj.setCoords();
  }

  function onScaling(e: any) {
    const obj = e.target;
    if (!obj) return;
    isDragging = true;
    guides = [];
    const t = threshold();

    const w = canvas.width || canvas.getWidth?.() || 1080;
    const h = canvas.height || canvas.getHeight?.() || 1350;

    const xTargets = [0, w / 2, w];
    const yTargets = [0, h / 2, h];

    const b = bounds(obj);

    // Snap right edge
    const snapRight = bestSnap([b.right], xTargets, t);
    if (snapRight) {
      const newW = snapRight.pos - b.left;
      obj.scaleX = newW / (obj.width || 1);
      if (snapRight.pos === w / 2) {
        guides.push({ axis: "x", pos: snapRight.pos });
      }
    }

    // Snap bottom edge
    const snapBottom = bestSnap([b.bottom], yTargets, t);
    if (snapBottom) {
      const newH = snapBottom.pos - b.top;
      obj.scaleY = newH / (obj.height || 1);
      if (snapBottom.pos === h / 2) {
        guides.push({ axis: "y", pos: snapBottom.pos });
      }
    }

    // Snap left edge (when dragging from left handle)
    const snapLeft = bestSnap([b.left], xTargets, t);
    if (snapLeft && !snapRight) {
      if (snapLeft.pos === w / 2) {
        guides.push({ axis: "x", pos: snapLeft.pos });
      }
    }

    // Snap top edge (when dragging from top handle)
    const snapTop = bestSnap([b.top], yTargets, t);
    if (snapTop && !snapBottom) {
      if (snapTop.pos === h / 2) {
        guides.push({ axis: "y", pos: snapTop.pos });
      }
    }

    obj.setCoords();
  }

  function onAfterRender() {
    if (!guides.length || !isDragging) return;
    const ctx = canvas.contextTop;
    if (!ctx) return;
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const W = canvas.width || canvas.getWidth?.() || 1080;
    const H = canvas.height || canvas.getHeight?.() || 1350;
    const canvasW = W * vpt[0];
    const canvasH = H * vpt[3];

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = GUIDE_COLOR;
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
      // Clear the top context to remove guide lines immediately
      const ctx = canvas.contextTop;
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width || 9999, canvas.height || 9999);
      }
      canvas.requestRenderAll();
    }
  }

  canvas.on("object:moving", onMoving);
  canvas.on("object:scaling", onScaling);
  canvas.on("after:render", onAfterRender);
  canvas.on("mouse:up", clearGuides);
  canvas.on("object:modified", clearGuides);
  canvas.on("selection:cleared", clearGuides);

  return () => {
    canvas.off("object:moving", onMoving);
    canvas.off("object:scaling", onScaling);
    canvas.off("after:render", onAfterRender);
    canvas.off("mouse:up", clearGuides);
    canvas.off("object:modified", clearGuides);
    canvas.off("selection:cleared", clearGuides);
  };
}
