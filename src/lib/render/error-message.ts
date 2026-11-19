/**
 * The stored failure message is shown in the dashboard and returned by the API
 * (and therefore in n8n), so it must read as a reason, not a debug dump:
 *
 *  - errors thrown inside the browser arrive as
 *    "page.evaluate: Error: <message>\n    at …stack" — keep the message;
 *  - Playwright launch errors append "Call log:" with every Chromium flag and
 *    "=====" banners — drop those (the server log keeps the full error).
 */
export function renderErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const message = raw
    .replace(/^(?:page|browserType|browser|context)\.\w+:\s*/i, "")
    .replace(/^Error:\s*/, "")
    .split(/\bCall log:/)[0]
    .replace(/={5,}/g, " ")
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return message.slice(0, 1000) || "Render failed";
}
