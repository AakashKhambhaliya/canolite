/**
 * The stored failure message is shown in the dashboard and returned by the API
 * (and therefore in n8n). Errors thrown inside the browser arrive as
 * "page.evaluate: Error: <message>\n    at …stack" — keep only the message.
 */
export function renderErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const message = raw
    .replace(/^page\.\w+:\s*/i, "")
    .replace(/^Error:\s*/, "")
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n")
    .trim();
  return message.slice(0, 1000) || "Render failed";
}
