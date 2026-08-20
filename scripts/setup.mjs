#!/usr/bin/env node
/**
 * Canolite — single-command local setup.
 *
 *   npm run setup
 *
 * Takes a fresh clone to a running app in one step: installs dependencies,
 * makes sure the matching Chromium is present, and starts the dev server.
 *
 * This script deliberately uses ONLY Node builtins. `npm run` executes it
 * straight from package.json, so it has to work before `npm install` has ever
 * run — importing anything from node_modules here would defeat the purpose.
 *
 * No .env is required: the database (embedded PostgreSQL), storage (local
 * filesystem) and asset URLs (relative) all have working defaults.
 *
 * Flags:
 *   --no-start    install and verify only; don't start the server
 *   --prod        build and run the production server instead of dev
 *   --port <n>    port to serve on (default 3000, or $PORT)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const noStart = argv.includes("--no-start");
const prod = argv.includes("--prod");
const portArg = argv.indexOf("--port");
const port = portArg !== -1 && argv[portArg + 1] ? argv[portArg + 1] : process.env.PORT || "3000";

const MIN_NODE_MAJOR = 22;

const c = {
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let step = 0;
const total = noStart ? 2 : 3;
const say = (msg) => console.log(`\n${c.blue(`[${++step}/${total}]`)} ${msg}`);
const ok = (msg) => console.log(`      ${c.green("✓")} ${msg}`);
const warn = (msg) => console.log(`      ${c.yellow("!")} ${msg}`);

function die(msg, hint) {
  console.error(`\n${c.red("✗ Setup failed:")} ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** Run a command to completion, inheriting stdio. Returns the exit code. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    // npm is a .cmd shim on Windows, which execvp can't run directly.
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.error) die(`could not run \`${cmd} ${args.join(" ")}\``, res.error.message);
  return res.status ?? 1;
}

// ── Node version ────────────────────────────────────────────────────────────
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
  die(
    `Node.js ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node}).`,
    "Next.js 15 and the embedded PostgreSQL binaries need a current Node. See https://nodejs.org."
  );
}

console.log(`\n${c.blue("Canolite")} ${c.dim("— local setup")}`);
console.log(c.dim(`  node ${process.versions.node} · ${process.platform}-${process.arch} · ${root}`));

// ── 1. Dependencies ─────────────────────────────────────────────────────────
say("Installing dependencies…");
if (run("npm", ["install", "--no-fund", "--no-audit"]) !== 0) {
  die("`npm install` failed.", "Scroll up for npm's error output.");
}
ok("Dependencies installed.");

// ── 2. Chromium (rendering) ─────────────────────────────────────────────────
// postinstall already attempts this; re-check so a skipped or failed download
// surfaces here rather than at the first render.
say("Checking the headless browser…");
let chromiumPath = null;
try {
  const { chromium } = await import("playwright");
  chromiumPath = chromium.executablePath();
} catch (error) {
  warn(`Could not load Playwright: ${error instanceof Error ? error.message : error}`);
}

if (chromiumPath && existsSync(chromiumPath)) {
  ok("Chromium is ready.");
} else {
  warn("Chromium missing — downloading (~150 MB, one time)…");
  const cli = path.join(root, "node_modules", "playwright", "cli.js");
  const code = existsSync(cli)
    ? run(process.execPath, [cli, "install", "chromium"])
    : run("npx", ["playwright", "install", "chromium"]);
  if (code === 0) {
    ok("Chromium is ready.");
  } else {
    warn("Chromium could not be installed. The app will run, but rendering will fail.");
    warn("Fix it later with: npx playwright install --with-deps chromium");
  }
}

// ── Notes on optional pieces ────────────────────────────────────────────────
if (process.env.DATABASE_URL) {
  console.log(`      ${c.dim(`Using external PostgreSQL from DATABASE_URL.`)}`);
} else {
  console.log(`      ${c.dim("Database: embedded PostgreSQL → ./data/pgdata (created on first boot).")}`);
}

if (noStart) {
  console.log(`\n${c.green("✓ Setup complete.")} Start the app with: ${c.blue("npm run dev")}\n`);
  process.exit(0);
}

// ── 3. Start ────────────────────────────────────────────────────────────────
if (prod) {
  say("Building for production…");
  if (run("npm", ["run", "build"]) !== 0) die("`npm run build` failed.");
  ok("Build complete.");
}

console.log(`\n${c.green("✓ Ready.")} Starting Canolite on ${c.blue(`http://localhost:${port}`)}`);
console.log(c.dim("  First boot initialises the database — it can take a few extra seconds."));
console.log(c.dim("  Open the URL and complete the one-time setup wizard. Ctrl-C to stop.\n"));

const child = spawn("npm", ["run", prod ? "start" : "dev"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, PORT: port },
});

// Forward signals so Ctrl-C shuts the server (and embedded Postgres) down cleanly.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
