#!/usr/bin/env node
/**
 * Download the Chromium build this Playwright version expects.
 *
 * Rendering needs a browser whose build number matches the installed Playwright
 * exactly (1.60.0 wants chromium-1223). The Dockerfile handles this itself, but
 * every other install path — a bare VPS, a Nixpacks/buildpack deploy, or a git
 * self-update that bumped the library — previously left the browser behind.
 * The app then started fine and failed only at the first render with:
 *
 *   browserType.launch: Executable doesn't exist at
 *   /root/.cache/ms-playwright/chromium_headless_shell-<build>/…
 *
 * Running as postinstall means the browser is fetched by the same command that
 * installs the library, so the two can't drift apart.
 *
 * Set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 to skip (the Docker build stages do,
 * since only the runner stage needs a browser).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1") {
  console.log(
    "[postinstall] PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — skipping Chromium download."
  );
  process.exit(0);
}

console.log("[postinstall] Ensuring the matching Chromium build is installed…");

// Resolve the CLI by path rather than trusting PATH. `node_modules/.bin` is
// only on PATH when npm invokes the script, and require.resolve() can't see
// playwright/cli.js because the package's "exports" map doesn't expose it —
// so a PATH lookup alone fails silently in exactly the situations that matter.
const localCli = path.join(process.cwd(), "node_modules", "playwright", "cli.js");

const res = existsSync(localCli)
  ? spawnSync(process.execPath, [localCli, "install", "chromium"], {
      stdio: "inherit",
    })
  : spawnSync("playwright", ["install", "chromium"], {
      stdio: "inherit",
      shell: true, // last resort: a globally installed CLI
    });

if (res.status === 0) {
  console.log("[postinstall] Chromium is ready.");
} else {
  // Never fail the install over this: a CI box or an offline machine that only
  // builds or type-checks doesn't need a browser, and a hard failure there is
  // worse than a warning. Rendering surfaces the same message if it's missing.
  console.warn(
    "\n[postinstall] Could not download Chromium automatically.\n" +
      "[postinstall] Rendering will fail until you run:\n" +
      "[postinstall]   npx playwright install --with-deps chromium\n"
  );
}

process.exit(0);
