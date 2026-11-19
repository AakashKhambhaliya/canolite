import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@/db";
import { renderJobs, templates } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export function privateMedia() {
  const mode = process.env.MEDIA_ACCESS || "public";
  if (mode !== "public" && mode !== "private") throw new Error("MEDIA_ACCESS must be public or private");
  return mode === "private";
}
// Next can serve files under public/ without the route handler at all. Never
// start in private mode with a static copy or an ambiguous storage location.
export async function checkPrivateStorage() {
  if (!privateMedia()) return;
  const dir = process.env.STORAGE_DIR;
  if (!dir || !path.isAbsolute(dir)) throw new Error("Private media requires an absolute STORAGE_DIR outside public/");
  await fs.mkdir(dir,{recursive:true});
  const root = await fs.realpath(dir), pub = await fs.realpath(path.resolve("public"));
  if (root === pub || root.startsWith(pub + path.sep) || pub.startsWith(root + path.sep)) throw new Error("Private media must not share a public directory");
  try {
    const legacy = path.join(pub,"storage");
    if ((await fs.lstat(legacy)).isSymbolicLink() || (await fs.readdir(legacy)).length) throw new Error("Move all legacy public/storage files offline before enabling private media");
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}
export async function projectOwnsMedia(projectId: string, key: string) {
  if (!projectId || key.split("/").some(p => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p))) return false;
  if (key.startsWith(`uploads/${projectId}/`)) return true;
  const render = /^renders\/([a-zA-Z0-9_-]+)\.(?:png|jpe?g|webp|mp4|poster\.jpg)$/.exec(key);
  if (render) {
    const [job] = await db.select({url:renderJobs.outputUrl,image:renderJobs.imageUrl,poster:renderJobs.posterUrl}).from(renderJobs)
      .where(and(eq(renderJobs.projectId,projectId),eq(renderJobs.uid,render[1]),eq(renderJobs.status,"done"))).limit(1);
    return !!job && Object.values(job).some(v => v && new URL(v,"https://media.invalid").pathname === `/storage/${key}`);
  }
  if (key.startsWith("thumbnails/")) {
    const [row] = await db.select({id:templates.id}).from(templates).where(and(eq(templates.projectId,projectId),eq(templates.thumbnailUrl,`/storage/${key}`),eq(templates.isDeleted,false))).limit(1);
    return !!row;
  }
  return false;
}
