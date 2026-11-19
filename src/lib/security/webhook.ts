import { createHmac, randomUUID } from "node:crypto";
import { fetchPublic } from "@/lib/ssrf";

export interface HookConfig { webhookUrl: string | null; webhookSecret: string | null }
export function hookDestination(config: HookConfig, override?: string | null) {
  const raw = override || config.webhookUrl;
  if (!raw) return null;
  const url = new URL(raw); url.hash = "";
  const configured = config.webhookUrl ? new URL(config.webhookUrl) : null;
  if (configured) configured.hash = "";
  // The signing key belongs to one exact receiver, not to API-key holders'
  // arbitrary per-request callback URLs. An override is a separate receiver.
  const secret = configured?.href === url.href ? config.webhookSecret : null;
  if (secret && url.protocol !== "https:") throw new Error("Signed webhooks require HTTPS");
  return { url: url.href, secret };
}
export function webhookEnvelope(event: string, fields: Record<string, unknown>, secret: string | null) {
  const body = JSON.stringify({ ...fields, event, event_id: randomUUID(), timestamp: new Date().toISOString() });
  const headers: Record<string,string> = { "Content-Type": "application/json", "X-Canolite-Event": event };
  if (secret) headers["X-Webhook-Signature"] = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return { body, headers };
}
export async function sendWebhook(config: HookConfig, override: string | null, event: string, fields: Record<string, unknown>) {
  const dest = hookDestination(config, override);
  if (!dest) return;
  const response = await fetchPublic(dest.url, { ...webhookEnvelope(event, fields, dest.secret), timeoutMs: 10_000, maxBytes: 0 });
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
}
