import { promises as fs } from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import { storageFilePath } from "@/lib/storage";
import { fetchPublic } from "@/lib/ssrf";
import { privateMedia, projectOwnsMedia } from "./media-access";
import { renderProject, renderSignal } from "./render-budget";

// This origin does not exist. All browser requests are fulfilled from approved
// bytes or aborted; the render document never needs access to the HTTP app.
export const RENDER_ORIGIN = "https://render-assets.invalid";
export const RENDER_CSP = `default-src 'none'; base-uri ${RENDER_ORIGIN}; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data: blob: ${RENDER_ORIGIN}; font-src data: ${RENDER_ORIGIN} https://fonts.gstatic.com; object-src 'none'; frame-src 'none'; connect-src 'none'`;
const mime: Record<string,string> = {png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",svg:"image/svg+xml",gif:"image/gif",woff:"font/woff",woff2:"font/woff2",ttf:"font/ttf",otf:"font/otf"};
export type Frames = {uid: string; root: string};
export function renderFile(url: URL, frames?: Frames) {
  if (url.origin !== RENDER_ORIGIN || url.username || url.password) return null;
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  if (parts.some(p => !p || p === "." || p === ".." || /[\/\\\x00-\x1f]/.test(p))) return null;
  const [area, ...rest] = parts;
  const contentType = mime[path.extname(rest.at(-1) || "").slice(1).toLowerCase()];
  if (!contentType) return null;
  if (area === "studio") return {root:path.join(process.cwd(), "public/studio"), key:rest.join("/"), contentType};
  if (area !== "storage") return null;
  if (rest[0] === "tmp") {
    if (!frames || rest[1] !== frames.uid || rest.length !== 4 || !/^\d{6}\.(jpg|png)$/.test(rest[3])) return null;
    return {root:frames.root, key:rest.slice(2).join("/"), contentType};
  }
  if (!["uploads","renders","thumbnails"].includes(rest[0])) return null;
  return {root:storageFilePath(""), key:rest.join("/"), contentType};
}
async function fileBytes(root: string, key: string, signal: AbortSignal) {
  const dir = await fs.realpath(root);
  const file = await fs.realpath(path.join(dir,key));
  if (!file.startsWith(dir + path.sep)) throw new Error("Invalid media path");
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Render asset too large");
    return await handle.readFile({signal});
  } finally { await handle.close(); }
}
export async function createRenderPage(browser: Browser, frames?: Frames) {
  const project = renderProject();
  const outer = renderSignal(); outer?.throwIfAborted();
  const context = await browser.newContext({viewport:{width:16,height:16}, deviceScaleFactor:1, serviceWorkers:"block", acceptDownloads:false});
  const controller = new AbortController();
  const abort = () => { controller.abort(); void context.close().catch(() => {}); };
  outer?.addEventListener("abort", abort, {once:true});
  context.once("close", () => { controller.abort(); outer?.removeEventListener("abort", abort); });
  try {
    outer?.throwIfAborted();
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
      try {
        const req = route.request();
        if (req.method() !== "GET" || req.isNavigationRequest()) return await route.abort();
        const url = new URL(req.url());
        const file = renderFile(url, frames);
        const headers = {"Access-Control-Allow-Origin":"*", "X-Content-Type-Options":"nosniff"};
        if (file && ["image","font"].includes(req.resourceType())) {
          if (url.pathname.startsWith("/storage/") && file.root !== frames?.root && privateMedia() && !(await projectOwnsMedia(project || "", file.key))) return await route.abort();
          return await route.fulfill({body:await fileBytes(file.root,file.key,controller.signal), contentType:file.contentType, headers});
        }
        const css = req.resourceType() === "stylesheet";
        const allowed = (u: URL) => u.origin === (css ? "https://fonts.googleapis.com" : "https://fonts.gstatic.com");
        if ((css || req.resourceType() === "font") && allowed(url)) {
          const res = await fetchPublic(url.href,{allowUrl:allowed, signal:controller.signal, maxBytes:css ? 512*1024 : 5*1024*1024, timeoutMs:5000, headers:{"User-Agent":req.headers()["user-agent"] || "Canolite"}});
          if (res.ok) return await route.fulfill({body:res.bytes, contentType:css ? "text/css" : "font/woff2", headers});
        }
      } catch { /* inaccessible or not allowlisted */ }
      await route.abort().catch(() => {});
    });
    return await context.newPage();
  } catch (error) { await context.close().catch(() => {}); throw error; }
}
