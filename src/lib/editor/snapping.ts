/**
 * Snapping + alignment guides for the Fabric editor (Photoshop-style).
 *
 * While an object (text, image, shape) is dragged, its edges and center snap to
 * the canvas only:
 *   - vertical & horizontal center
 *   - the four sides (left / right / top / bottom edges)
 *
 * At most one vertical and one horizontal magenta guide is shown at a time —
 * clean and predictable, not a grid. Call the returned function to uninstall.
 */
type FabricNS = any;

const GUIDE_COLOR = "#ff2d78"; // smart-guide magenta
const SNAP_THRESHOLD = 6; // screen pixels

interface Guide {
  axis: "x" | "y";
  pos: number; // canvas-space coordinate
}

export function installSnapping(canvas: any, _fabric: FabricNS): () => void {
  let guides: Guide[] = [];

  const threshold = () => SNAP_THRESHOLD / canvas.getZoom();

  function bounds(obj: any) {
    const r = obj.getBoundingRect(true, true);
    return {
      left: r.left,
      right: r.left + r.width,
      cx: r.left + r.width / 2,
      top: r.top,
      bottom: r.top + r.height,
      cy: r.top + r.height / 2,
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
    guides = [];
    const t = threshold();

    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const w = canvas.getWidth() / vpt[0];
    const h = canvas.getHeight() / vpt[3];

    // Canvas-only snap targets: sides + center (no per-object grid).
    const xTargets = [0, w / 2, w];
    const yTargets = [0, h / 2, h];
    const b = bounds(obj);

    const snapX = bestSnap([b.left, b.cx, b.right], xTargets, t);
    if (snapX) {
      obj.left += snapX.delta;
      guides.push({ axis: "x", pos: snapX.pos });
    }

    const snapY = bestSnap([b.top, b.cy, b.bottom], yTargets, t);
    if (snapY) {
      obj.top += snapY.delta;
      guides.push({ axis: "y", pos: snapY.pos });
    }

    obj.setCoords();
  }

  function onAfterRender() {
    if (!guides.length) return;
    const ctx = canvas.contextTop;
    if (!ctx) return;
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const W = canvas.getWidth();
    const H = canvas.getHeight();

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = GUIDE_COLOR;
    for (const g of guides) {
      ctx.beginPath();
      if (g.axis === "x") {
        const x = Math.round(g.pos * vpt[0] + vpt[4]) + 0.5; // crisp 1px
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      } else {
        const y = Math.round(g.pos * vpt[3] + vpt[5]) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function clearGuides() {
    if (guides.length) {
      guides = [];
      canvas.requestRenderAll();
    }
  }

  canvas.on("object:moving", onMoving);
  canvas.on("after:render", onAfterRender);
  canvas.on("mouse:up", clearGuides);
  canvas.on("object:modified", clearGuides);

  return () => {
    canvas.off("object:moving", onMoving);
    canvas.off("after:render", onAfterRender);
    canvas.off("mouse:up", clearGuides);
    canvas.off("object:modified", clearGuides);
  };
}
