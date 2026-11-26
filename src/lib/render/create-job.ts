import { insertJobs, RenderAdmissionError } from "./admission";
/**
 * Shared render-job creation.
 *
 * Both the dashboard routes (session auth) and the public v1 API (API-key auth)
 * create render jobs the same way: look up the template, resolve output
 * settings, validate modifications, and insert job rows. This module is the
 * single source of truth for that logic so the routes don't duplicate it.
 */
import { db } from "@/db";
import { templates, renderJobs, projects } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/utils";
import { applyModifications, type Modification } from "./apply-modifications";
import { availableFontsForProject } from "./prepare-design";
import { createUrlSafetyChecker, TooManyHostsError, type UrlSafetyChecker } from "@/lib/ssrf";
import { config } from "@/lib/config";
import {
  crfToVideoQuality,
  projectDefaultsLayer,
  resolveOutputSettings,
  videoQualityToCrf,
  type OutputSettings,
  type PartialOutputSettings,
  type VideoQualityPreset,
} from "@/lib/output-settings";

export interface OutputOptions {
  format?: string;
  quality?: number;
  scale?: number;
}

export interface GlobalDefaults {
  defaultFormat?: string | null;
  defaultQuality?: number | null;
  defaultScale?: number | null;
  defaultFps?: number | null;
  defaultVideoQuality?: string | null;
}

export interface ResolvedOutput {
  format: string;
  quality: number;
  scale: number;
}

/**
 * Resolve an image render's output settings.
 *
 * The precedence chain (request → template → project → fallback) lives in
 * lib/output-settings.ts and is shared with every UI surface, so what the
 * Playground previews is what the renderer produces.
 */
export function resolveOutput(
  template: { outputDefaults?: unknown },
  opts: OutputOptions,
  global?: GlobalDefaults
): ResolvedOutput {
  const resolved = resolveOutputSettings(
    projectDefaultsLayer(global),
    (template.outputDefaults as PartialOutputSettings) || {},
    opts as PartialOutputSettings
  );
  return {
    format: resolved.format,
    quality: resolved.quality,
    scale: resolved.scale,
  };
}

/**
 * Resolve a video render's settings the same way, including the MP4-only
 * fields. Video used to skip the project defaults entirely, so the fps and
 * quality set in Settings had no effect on an MP4 render.
 */
export function resolveVideoOutput(
  template: { outputDefaults?: unknown; videoDefaults?: unknown },
  opts: VideoJobOptions | undefined,
  global?: GlobalDefaults
): OutputSettings {
  const videoDefaults = (template.videoDefaults as any) || {};
  return resolveOutputSettings(
    // VIDEO_DEFAULT_FPS is the deployment-wide floor; anything the project,
    // template or request says overrides it.
    { fps: config.VIDEO_DEFAULT_FPS },
    projectDefaultsLayer(global),
    {
      ...((template.outputDefaults as PartialOutputSettings) || {}),
      fps: videoDefaults.fps,
      durationSec: videoDefaults.durationSec,
      videoQuality:
        videoDefaults.crf !== undefined
          ? crfToVideoQuality(videoDefaults.crf)
          : undefined,
    },
    {
      fps: opts?.fps,
      durationSec: opts?.durationSec,
      scale: opts?.scale,
      videoQuality: opts?.quality,
    }
  );
}

async function fetchGlobalDefaults(projectId: string): Promise<GlobalDefaults> {
  const [project] = await db
    .select({
      defaultFormat: projects.defaultFormat,
      defaultQuality: projects.defaultQuality,
      defaultScale: projects.defaultScale,
      defaultFps: projects.defaultFps,
      defaultVideoQuality: projects.defaultVideoQuality,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project || {};
}

/**
 * The output format a render request will ACTUALLY use, once the template's
 * and project's defaults are applied. Routes branch image-vs-video on this:
 * branching on the raw request field sent an omitted `format` down the image
 * path even when the defaults said "mp4", producing a PNG labelled mp4.
 * Returns null when the template doesn't exist.
 */
export async function effectiveFormat(
  projectId: string,
  templateId: string,
  requested?: string | null
): Promise<string | null> {
  const template = await findTemplate(projectId, templateId);
  if (!template) return null;
  if (requested) return requested;
  const globalDefaults = await fetchGlobalDefaults(projectId);
  return resolveOutput(template, {}, globalDefaults).format;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reject malformed batch items up front (400) rather than crashing (500). */
function assertBatchItems(items: unknown): asserts items is { modifications?: Modification[]; webhook_url?: string | null }[] {
  if (!Array.isArray(items)) throw new RenderAdmissionError("items must be an array", 400);
  items.forEach((item, i) => {
    if (!isPlainObject(item)) throw new RenderAdmissionError(`items[${i}] must be an object`, 400);
    if (item.webhook_url != null && typeof item.webhook_url !== "string") {
      throw new RenderAdmissionError(`items[${i}].webhook_url must be a string`, 400);
    }
  });
}

/** Check many items' URLs with one shared, bounded checker. */
async function sanitizeItems<T extends { modifications?: Modification[] }>(items: T[]) {
  const check = createUrlSafetyChecker();
  return Promise.all(items.map((item) => sanitizeModifications(item.modifications || [], check)));
}

export async function findTemplate(projectId: string, templateId: string) {
  const [template] = await db
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.templateId, templateId),
        eq(templates.projectId, projectId),
        eq(templates.isDeleted, false)
      )
    )
    .limit(1);
  return template ?? null;
}

/**
 * Drop image_url modifications that point at non-public hosts (SSRF guard) and
 * collect warnings for the caller.
 */
export async function sanitizeModifications(
  mods: Modification[],
  check: UrlSafetyChecker = createUrlSafetyChecker()
): Promise<{ mods: Modification[]; warnings: string[] }> {
  if (!Array.isArray(mods) || mods.length > 256) throw new RenderAdmissionError("Maximum 256 modifications per render", 400);
  // Dashboard routes don't run the v1 Zod schema, so entries can be anything:
  // a null entry used to crash this loop with a 500.
  mods.forEach((m, i) => {
    if (!isPlainObject(m)) throw new RenderAdmissionError(`modifications[${i}] must be an object`, 400);
    for (const key of ["image_url", "video_url"] as const) {
      if (m[key] != null && typeof m[key] !== "string") {
        throw new RenderAdmissionError(`modifications[${i}].${key} must be a string`, 400);
      }
    }
  });
  try {
    // All URLs are checked concurrently (the checker bounds concurrency and
    // dedupes hosts); results are applied in order.
    const verdicts = await Promise.all(
      mods.map(async (m) => ({
        image: m.image_url ? await check(m.image_url) : true,
        video: m.video_url ? await check(m.video_url) : true,
      }))
    );
    const warnings: string[] = [];
    const out: Modification[] = mods.map((m, i) => {
      let cleaned = { ...m };
      if (!verdicts[i].image) {
        warnings.push(
          `Blocked image_url for "${m.name}" — only public http(s) URLs are allowed`
        );
        const { image_url, ...rest } = cleaned;
        cleaned = rest;
      }
      if (!verdicts[i].video) {
        warnings.push(
          `Blocked video_url for "${m.name}" — only public http(s) URLs are allowed`
        );
        const { video_url, ...rest } = cleaned;
        cleaned = rest;
      }
      return cleaned;
    });
    return { mods: out, warnings };
  } catch (error) {
    if (error instanceof TooManyHostsError) throw new RenderAdmissionError(error.message, 400);
    throw error;
  }
}

export interface CreatedRender {
  job: typeof renderJobs.$inferSelect;
  warnings: string[];
  resolved: ResolvedOutput;
}

/**
 * Create a single render job. Returns null if the template doesn't exist.
 */
export async function createRenderJob(params: {
  projectId: string;
  templateId: string;
  modifications?: Modification[];
  output: OutputOptions;
  webhookUrl?: string | null;
  batchUid?: string;
}): Promise<CreatedRender | null> {
  const template = await findTemplate(params.projectId, params.templateId);
  if (!template) return null;

  const globalDefaults = await fetchGlobalDefaults(params.projectId);
  const resolved = resolveOutput(template, params.output, globalDefaults);
  if (resolved.format === "mp4") {
    throw new RenderAdmissionError("MP4 output is a video render; submit it as a video job", 400);
  }
  const { mods, warnings: ssrfWarnings } = await sanitizeModifications(
    params.modifications || []
  );
  const { warnings: modWarnings } = applyModifications(
    template.designJson,
    mods,
    await availableFontsForProject(params.projectId)
  );

  const [job] = await insertJobs(params.projectId, [{
      uid: generateId("img"),
      batchUid: params.batchUid,
      templateId: template.id,
      projectId: params.projectId,
      status: "queued",
      modifications: mods,
      format: resolved.format,
      quality: resolved.quality,
      scale: resolved.scale,
      webhookUrl: params.webhookUrl || null,
    }], true);

  return { job, warnings: [...ssrfWarnings, ...modWarnings], resolved };
}

export interface CreatedBatch {
  batchUid: string;
  uids: string[];
  resolved: ResolvedOutput;
  templateUid: string;
}

/**
 * Create a batch of render jobs. Returns null if the template doesn't exist.
 */
export async function createBatchJobs(params: {
  projectId: string;
  templateId: string;
  items: { modifications?: Modification[]; webhook_url?: string | null }[];
  output: OutputOptions;
}): Promise<CreatedBatch | null> {
  const template = await findTemplate(params.projectId, params.templateId);
  if (!template) return null;

  assertBatchItems(params.items);
  const globalDefaults = await fetchGlobalDefaults(params.projectId);
  const resolved = resolveOutput(template, params.output, globalDefaults);
  if (resolved.format === "mp4") {
    throw new RenderAdmissionError("MP4 output is a video render; submit it as a video batch", 400);
  }
  const batchUid = generateId("batch");
  const uids: string[] = [];

  const sanitized = await sanitizeItems(params.items);
  const rows = [];
  for (const [index, item] of params.items.entries()) {
    const { mods } = sanitized[index];
    const uid = generateId("img");
    uids.push(uid);
    rows.push({
      uid,
      batchUid,
      templateId: template.id,
      projectId: params.projectId,
      status: "queued" as const,
      modifications: mods,
      format: resolved.format,
      quality: resolved.quality,
      scale: resolved.scale,
      webhookUrl: item.webhook_url || null,
    });
  }

  await insertJobs(params.projectId, rows);

  return { batchUid, uids, resolved, templateUid: template.templateId };
}

export interface VideoJobOptions {
  fps?: number;
  durationSec?: number;
  quality?: VideoQualityPreset | string;
  scale?: number;
}

/** Apply the server-side caps (env-configurable) on top of the resolved values. */
function cappedVideoFields(resolved: OutputSettings) {
  return {
    fps: Math.min(Math.max(1, Math.round(resolved.fps)), config.VIDEO_MAX_FPS),
    durationSec: resolved.durationSec
      ? Math.min(
          Math.max(1, Math.ceil(resolved.durationSec)),
          config.VIDEO_MAX_OUTPUT_SEC
        )
      : null,
    crf: videoQualityToCrf(resolved.videoQuality),
    scale: resolved.scale,
  };
}

export async function createVideoRenderJob(params: {
  projectId: string;
  templateId: string;
  modifications?: Modification[];
  output?: VideoJobOptions;
  webhookUrl?: string | null;
  batchUid?: string;
}): Promise<CreatedRender | null> {
  const template = await findTemplate(params.projectId, params.templateId);
  if (!template) return null;
  // A caller mistake, not a server fault: 400, not 500.
  if (!template.hasVideo) throw new RenderAdmissionError("Template does not contain video layers", 400);

  const { mods, warnings: ssrfWarnings } = await sanitizeModifications(params.modifications || []);
  const { warnings: modWarnings } = applyModifications(template.designJson, mods, await availableFontsForProject(params.projectId));
  const globalDefaults = await fetchGlobalDefaults(params.projectId);
  const video = cappedVideoFields(
    resolveVideoOutput(template, params.output, globalDefaults)
  );

  const [job] = await insertJobs(params.projectId, [{
      uid: generateId("vid"),
      batchUid: params.batchUid,
      templateId: template.id,
      projectId: params.projectId,
      status: "queued",
      modifications: mods,
      format: "mp4",
      quality: video.crf,
      scale: video.scale,
      outputKind: "video",
      mimeType: "video/mp4",
      fps: video.fps,
      durationSec: video.durationSec,
      progress: 0,
      webhookUrl: params.webhookUrl || null,
    }], true);

  return {
    job,
    warnings: [...ssrfWarnings, ...modWarnings],
    resolved: { format: "mp4", quality: video.crf, scale: video.scale },
  };
}

export async function createVideoBatchJobs(params: {
  projectId: string;
  templateId: string;
  items: { modifications?: Modification[]; webhook_url?: string | null }[];
  output?: VideoJobOptions;
}): Promise<CreatedBatch | null> {
  const template = await findTemplate(params.projectId, params.templateId);
  if (!template) return null;
  if (!template.hasVideo) throw new RenderAdmissionError("Template does not contain video layers", 400);
  assertBatchItems(params.items);
  const batchUid = generateId("vbatch");
  const uids: string[] = [];
  const rows = [];
  const globalDefaults = await fetchGlobalDefaults(params.projectId);
  const video = cappedVideoFields(
    resolveVideoOutput(template, params.output, globalDefaults)
  );
  const sanitized = await sanitizeItems(params.items);
  for (const [index, item] of params.items.entries()) {
    const { mods } = sanitized[index];
    const uid = generateId("vid");
    uids.push(uid);
    rows.push({
      uid,
      batchUid,
      templateId: template.id,
      projectId: params.projectId,
      status: "queued" as const,
      modifications: mods,
      format: "mp4",
      quality: video.crf,
      scale: video.scale,
      outputKind: "video",
      mimeType: "video/mp4",
      fps: video.fps,
      durationSec: video.durationSec,
      progress: 0,
      webhookUrl: item.webhook_url || null,
    });
  }
  await insertJobs(params.projectId, rows);
  return {
    batchUid,
    uids,
    resolved: { format: "mp4", quality: video.crf, scale: video.scale },
    templateUid: template.templateId,
  };
}
