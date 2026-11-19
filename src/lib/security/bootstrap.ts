import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * First-run setup token.
 *
 * The setup wizard creates the only admin account, so whoever reaches it first
 * on a freshly started, publicly reachable instance would own it. It therefore
 * requires a token only the operator can see:
 *
 *  - CANOLITE_SETUP_TOKEN, when the operator sets one (≥ 32 chars), or
 *  - otherwise a random one-time token generated at boot and printed to the
 *    server log (`docker compose logs canolite`), Jupyter-style.
 *
 * The generated token lives on globalThis rather than module scope: Next.js
 * bundles instrumentation and each route separately, so module state is not
 * shared between them, but the Node process (and its globalThis) is.
 */
const MIN_TOKEN_LENGTH = 32;
const shared = globalThis as typeof globalThis & { __canoliteSetupToken?: string };

function configuredToken(): string | undefined {
  const value = process.env.CANOLITE_SETUP_TOKEN?.trim();
  return value && value.length >= MIN_TOKEN_LENGTH ? value : undefined;
}

/** The token the setup wizard currently accepts (generating one if needed). */
export function currentSetupToken(): string {
  return configuredToken() ?? (shared.__canoliteSetupToken ??= randomBytes(24).toString("hex"));
}

/**
 * Called at boot while setup is still pending. Prints where the token comes
 * from; prints the token itself only when it was generated (never echo an
 * operator-provided secret into logs).
 */
export function announceSetupToken(log: (line: string) => void = console.log): void {
  const raw = process.env.CANOLITE_SETUP_TOKEN?.trim();
  if (raw && raw.length < MIN_TOKEN_LENGTH) {
    log(`[setup] CANOLITE_SETUP_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters and was ignored.`);
  }
  if (configuredToken()) {
    log("[setup] Admin not configured yet. Open /setup and enter your CANOLITE_SETUP_TOKEN.");
    return;
  }
  log("[setup] Admin not configured yet. Open /setup and enter this one-time setup token:");
  log(`[setup]   ${currentSetupToken()}`);
  log("[setup] (It changes on every restart until setup is complete. Set CANOLITE_SETUP_TOKEN to pin it.)");
}

// Operator-provided, never generated in a response or inferred from IP/proxy headers.
export function bootstrapAuthorized(submitted: unknown, expected: string | undefined = currentSetupToken()) {
  if (!expected || expected.length < MIN_TOKEN_LENGTH || typeof submitted !== "string" || submitted.length > 4096) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(submitted.trim()));
}
