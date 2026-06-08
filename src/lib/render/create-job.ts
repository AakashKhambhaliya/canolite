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
async function sanitizeModifications(
  mods: Modification[]
): Promise<{ mods: Modification[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: Modification[] = [];
  for (const m of mods) {
    if (m.image_url && !(await isUrlSafe(m.image_url))) {
      warnings.push(
        `Blocked image_url for "${m.name}" — only public http(s) URLs are allowed`
      );
      const { image_url, ...rest } = m;
      out.push(rest);
    } else {
      out.push(m);
    }
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
