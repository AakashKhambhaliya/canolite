import { NextResponse } from "next/server";
import { db } from "@/db";
import { renderJobs, templates } from "@/db/schema";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { buildRenderTimeStats, type RenderSample } from "@/lib/render-time";
import { config } from "@/lib/config";

/**
 * GET /api/renders/stats — how long this project's renders actually take.
 *
 * Every finished job already stored its `duration_ms`; nothing read it back, so
 * the app could never tell anyone how long a render would take. This turns the
 * recent history into medians the dashboard uses for "Est. time" before a
 * render starts and for the remaining-time readout while one runs.
 *
 * Only the most recent window is considered: render times track the machine and
 * the template, and a year-old sample from a different host would drag the
 * median somewhere useless.
 */
const SAMPLE_WINDOW = 200;

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const rows = await db
      .select({
        durationMs: renderJobs.durationMs,
        outputKind: renderJobs.outputKind,
        scale: renderJobs.scale,
        fps: renderJobs.fps,
        durationSec: renderJobs.durationSec,
        frameCount: renderJobs.frameCount,
        templateUid: templates.templateId,
        width: templates.width,
        height: templates.height,
      })
      .from(renderJobs)
      .leftJoin(templates, eq(renderJobs.templateId, templates.id))
      .where(
        and(
          eq(renderJobs.projectId, user.projectId),
          eq(renderJobs.status, "done"),
          isNotNull(renderJobs.durationMs)
        )
      )
      .orderBy(desc(renderJobs.createdAt))
      .limit(SAMPLE_WINDOW);

    const samples: RenderSample[] = rows
      .filter((r) => (r.durationMs ?? 0) > 0)
      .map((r) => {
        const scale = r.scale && r.scale > 0 ? r.scale : 1;
        const megapixels =
          r.width && r.height
            ? (r.width * scale * r.height * scale) / 1_000_000
            : null;
        // frameCount is the truth when the renderer recorded it; otherwise the
        // requested fps x duration is the best available proxy.
        const frames =
          r.frameCount && r.frameCount > 0
            ? r.frameCount
            : r.fps && r.durationSec
              ? r.fps * r.durationSec
              : null;
        return {
          kind: r.outputKind === "video" ? "video" : "image",
          templateId: r.templateUid ?? null,
          durationMs: r.durationMs as number,
          megapixels,
          frames,
        };
      });

    const active = await db
      .select({ id: renderJobs.id })
      .from(renderJobs)
      .where(
        and(
          eq(renderJobs.projectId, user.projectId),
          inArray(renderJobs.status, ["queued", "processing"])
        )
      );

    return NextResponse.json(
      buildRenderTimeStats(samples, active.length, {
        image: config.RENDER_CONCURRENCY,
        video: config.VIDEO_CONCURRENCY,
      })
    );
  } catch (error) {
    console.error("Error building render stats:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
