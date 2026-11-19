/**
 * Renders must survive hosts without a usable Chromium sandbox (Docker,
 * Coolify): in "auto" mode a sandboxed launch that fails with the sandbox
 * error falls back to an unsandboxed one; "on" must not fall back; "off" never
 * tries the sandbox. The launcher is stubbed so this runs on any OS.
 */
import { launchChromium } from "../../src/lib/render/render-image";

const SANDBOX_ERROR =
  "browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\nChromium sandboxing failed!\n" +
  "[pid=94][err] [1119/123610.381625:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox!";

let passed = 0, failed = 0;
const assert = (ok: boolean, label: string) => { console.log(`  ${ok ? "✅" : "❌"} ${label}`); if (ok) passed++; else failed++; };

function dockerLike(calls: boolean[], error = SANDBOX_ERROR) {
  return async (sandbox: boolean) => {
    calls.push(sandbox);
    if (sandbox) throw new Error(error);
    return "browser";
  };
}

(async () => {
  console.log("\n🧪 Chromium sandbox fallback");

  let calls: boolean[] = []; const warnings: string[] = [];
  const b = await launchChromium(dockerLike(calls), "auto", (m) => warnings.push(m));
  assert(b === "browser" && calls.join(",") === "true,false", "auto: tries the sandbox, then launches without it in Docker");
  assert(warnings.length === 1 && /sandbox is unavailable/.test(warnings[0]), "auto: logs a warning");

  calls = [];
  let err = "";
  try { await launchChromium(dockerLike(calls), "on", () => {}); } catch (e) { err = (e as Error).message; }
  assert(/No usable sandbox/.test(err) && calls.join(",") === "true", "on: a missing sandbox stays an error");

  calls = [];
  await launchChromium(dockerLike(calls), "off", () => {});
  assert(calls.join(",") === "false", "off: never attempts the sandbox");

  calls = []; err = "";
  try { await launchChromium(dockerLike(calls, "Executable doesn't exist at /ms-playwright"), "auto", () => {}); } catch (e) { err = (e as Error).message; }
  assert(/Executable doesn't exist/.test(err) && calls.join(",") === "true", "auto: other launch errors are not retried");

  calls = [];
  const ok = await launchChromium(async (s: boolean) => { calls.push(s); return "sandboxed"; }, "auto", () => {});
  assert(ok === "sandboxed" && calls.join(",") === "true", "auto: keeps the sandbox where the host supports it");

  console.log(`\n  RESULTS: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
