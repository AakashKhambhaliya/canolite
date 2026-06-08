/**
 * Snapping + alignment guides for the Fabric editor.
 *
 * While an object (text, image, shape) is dragged, its edges and center snap to:
 *   - the canvas edges, corners, and center (both axes)
 *   - the edges and centers of every other object
 *
 * Magenta guide lines are drawn on the upper canvas while a snap is active.
 * Call the returned function to uninstall the handlers.
 */
type FabricNS = any;

const GUIDE_COLOR = "#e5267d";
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

  function onMoving(e: any) {
    const obj = e.target;
    if (!obj) return;
    guides = [];
    const t = threshold();

    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const w = canvas.getWidth() / vpt[0];
    const h = canvas.getHeight() / vpt[3];

    // Build snap targets for each axis from the canvas and the other objects.
    const xTargets: number[] = [0, w / 2, w];
    const yTargets: number[] = [0, h / 2, h];
    for (const other of canvas.getObjects()) {
      if (other === obj) continue;
      const b = bounds(other);
      xTargets.push(b.left, b.cx, b.right);
      yTargets.push(b.top, b.cy, b.bottom);
    }

    const b = bounds(obj);

    // X axis: try snapping left / center / right of the moving object.
    let bestX: { delta: number; pos: number; dist: number } | null = null;
    for (const [edge, val] of [
      ["left", b.left],
      ["cx", b.cx],
      ["right", b.right],
    ] as const) {
      for (const target of xTargets) {
        const dist = Math.abs(val - target);
        if (dist <= t && (!bestX || dist < bestX.dist)) {
          bestX = { delta: target - val, pos: target, dist };
        }
      }
    }
    if (bestX) {
      obj.left += bestX.delta;
      guides.push({ axis: "x", pos: bestX.pos });
    }

    // Y axis.
    let bestY: { delta: number; pos: number; dist: number } | null = null;
    for (const [edge, val] of [
      ["top", b.top],
      ["cy", b.cy],
      ["bottom", b.bottom],
    ] as const) {
      for (const target of yTargets) {
        const dist = Math.abs(val - target);
        if (dist <= t && (!bestY || dist < bestY.dist)) {
          bestY = { delta: target - val, pos: target, dist };
        }
      }
    }
    if (bestY) {
      obj.top += bestY.delta;
      guides.push({ axis: "y", pos: bestY.pos });
    }

    obj.setCoords();
  }

  function onAfterRender() {
    if (!guides.length) return;
    const ctx = canvas.contextTop;
    if (!ctx) return;
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = GUIDE_COLOR;
    for (const g of guides) {
      ctx.beginPath();
      if (g.axis === "x") {
        const x = g.pos * vpt[0] + vpt[4];
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.getHeight());
      } else {
        const y = g.pos * vpt[3] + vpt[5];
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.getWidth(), y);
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
