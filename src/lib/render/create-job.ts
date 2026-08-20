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
import { isUrlSafe } from "@/lib/ssrf";
import { config } from "@/lib/config";

export interface OutputOptions {
  format?: string;
  quality?: number;
  scale?: number;
}

export interface GlobalDefaults {
  defaultFormat?: string | null;
  defaultQuality?: number | null;
  defaultScale?: number | null;
}

export interface ResolvedOutput {
  format: string;
  quality: number;
  scale: number;
}

export function resolveOutput(
  template: { outputDefaults?: unknown },
  opts: OutputOptions,
  global?: GlobalDefaults
): ResolvedOutput {
  const tpl = (template.outputDefaults as any) || {};
  const g = global || {};
  // Priority: API request → template-level → global settings → hardcoded
  return {
    format: opts.format || tpl.format || g.defaultFormat || "png",
    quality: opts.quality || tpl.quality || g.defaultQuality || 90,
    scale: Math.min(opts.scale || tpl.scale || g.defaultScale || 1, 4),
  };
}

async function fetchGlobalDefaults(projectId: string): Promise<GlobalDefaults> {
  const [project] = await db
    .select({
      defaultFormat: projects.defaultFormat,
      defaultQuality: projects.defaultQuality,
      defaultScale: projects.defaultScale,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project || {};
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
  mods: Modification[]
): Promise<{ mods: Modification[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: Modification[] = [];
  for (const m of mods) {
    let cleaned = { ...m };
    if (m.image_url && !(await isUrlSafe(m.image_url))) {
      warnings.push(
        `Blocked image_url for "${m.name}" — only public http(s) URLs are allowed`
      );
      const { image_url, ...rest } = cleaned;
      cleaned = rest;
    }
    if (m.video_url && !(await isUrlSafe(m.video_url))) {
      warnings.push(
        `Blocked video_url for "${m.name}" — only public http(s) URLs are allowed`
      );
      const { video_url, ...rest } = cleaned;
      cleaned = rest;
    }
    out.push(cleaned);
  }
  return { mods: out, warnings };
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
  const { mods, warnings: ssrfWarnings } = await sanitizeModifications(
    params.modifications || []
  );
  const { warnings: modWarnings } = applyModifications(
    template.designJson,
    mods
  );

  const [job] = await db
    .insert(renderJobs)
    .values({
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
    })
    .returning();

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

  const globalDefaults = await fetchGlobalDefaults(params.projectId);
  const resolved = resolveOutput(template, params.output, globalDefaults);
  const batchUid = generateId("batch");
  const uids: string[] = [];

  const rows = [];
  for (const item of params.items) {
    const { mods } = await sanitizeModifications(item.modifications || []);
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

  await db.insert(renderJobs).values(rows);

  return { batchUid, uids, resolved, templateUid: template.templateId };
}

export interface VideoJobOptions {
  fps?: number;
  durationSec?: number;
  quality?: "high" | "balanced" | "small";
  scale?: number;
}

function videoQualityToCrf(quality?: "high" | "balanced" | "small"): number {
  if (quality === "high") return 18;
  if (quality === "small") return 28;
  return 23;
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
  if (!template.hasVideo) throw new Error("Template does not contain video layers");

  const { mods, warnings: ssrfWarnings } = await sanitizeModifications(params.modifications || []);
  const { warnings: modWarnings } = applyModifications(template.designJson, mods);
  const fps = params.output?.fps || (template.videoDefaults as any)?.fps || config.VIDEO_DEFAULT_FPS;
  const maxFps = config.VIDEO_MAX_FPS;
  const durationSec = params.output?.durationSec || (template.videoDefaults as any)?.durationSec;
  const maxDuration = config.VIDEO_MAX_OUTPUT_SEC;

  const [job] = await db
    .insert(renderJobs)
    .values({
      uid: generateId("vid"),
      batchUid: params.batchUid,
      templateId: template.id,
      projectId: params.projectId,
      status: "queued",
      modifications: mods,
      format: "mp4",
      quality: videoQualityToCrf(params.output?.quality),
      scale: Math.min(params.output?.scale || 1, 4),
      outputKind: "video",
      mimeType: "video/mp4",
      fps: Math.min(Math.max(1, Math.round(fps)), maxFps),
      durationSec: durationSec ? Math.min(Math.max(1, Math.ceil(durationSec)), maxDuration) : null,
      progress: 0,
      webhookUrl: params.webhookUrl || null,
    })
    .returning();

  return {
    job,
    warnings: [...ssrfWarnings, ...modWarnings],
    resolved: { format: "mp4", quality: videoQualityToCrf(params.output?.quality), scale: params.output?.scale || 1 },
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
  if (!template.hasVideo) throw new Error("Template does not contain video layers");
  const batchUid = generateId("vbatch");
  const uids: string[] = [];
  const rows = [];
  const fps = params.output?.fps || (template.videoDefaults as any)?.fps || config.VIDEO_DEFAULT_FPS;
  const maxFps = config.VIDEO_MAX_FPS;
  const maxDuration = config.VIDEO_MAX_OUTPUT_SEC;
  for (const item of params.items) {
    const { mods } = await sanitizeModifications(item.modifications || []);
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
      quality: videoQualityToCrf(params.output?.quality),
      scale: Math.min(params.output?.scale || 1, 4),
      outputKind: "video",
      mimeType: "video/mp4",
      fps: Math.min(Math.max(1, Math.round(fps)), maxFps),
      durationSec: params.output?.durationSec ? Math.min(Math.max(1, Math.ceil(params.output.durationSec)), maxDuration) : null,
      progress: 0,
      webhookUrl: item.webhook_url || null,
    });
  }
  await db.insert(renderJobs).values(rows);
  return { batchUid, uids, resolved: { format: "mp4", quality: videoQualityToCrf(params.output?.quality), scale: params.output?.scale || 1 }, templateUid: template.templateId };
}
