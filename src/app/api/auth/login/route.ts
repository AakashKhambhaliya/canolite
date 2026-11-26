import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { getAdminUser, verifyPassword } from "@/lib/admin";
import {
  clearRateLimit,
  clientKey,
  releaseAttempt,
  reserveAttempt,
} from "@/lib/rate-limit";
import { bodyErrorResponse, readJsonBody } from "@/lib/json-body";

/**
 * Brute-force limits. There is exactly one account on a Canolite instance, so
 * an unthrottled login endpoint is a single-target password oracle: bcrypt at
 * cost 10 still allows well over a thousand guesses an hour against a short
 * password. Ten failures per IP per 15 minutes leaves plenty of room for an
 * operator mistyping their password.
 */
const PER_IP_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

/**
 * Backstop for a spray from many source addresses (and for the case where the
 * app is exposed directly, so X-Forwarded-For is attacker-controlled). Set well
 * above the per-IP limit: a single admin never generates this many failures,
 * but a botnet hits it long before it can work through a password list.
 */
const GLOBAL_LIMIT = { limit: 50, windowMs: 15 * 60 * 1000 };
const GLOBAL_KEY = "login:global";

function lockedOut(retryAfterSec: number) {
  return NextResponse.json(
    {
      error: `Too many failed sign-in attempts. Try again in ${Math.ceil(
        retryAfterSec / 60
      )} minute(s).`,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}

/**
 * Single-admin sign in.
 *
 * Credentials are stored on the admin user row (set during first-run setup or
 * via the ADMIN_EMAIL/ADMIN_PASSWORD env vars). If setup hasn't run yet, the
 * client is told to redirect to the setup wizard.
 */
export async function POST(request: Request) {
  const ipKey = `login:${clientKey(request)}`;

  // Reserve a slot in BOTH buckets synchronously, before any await. A plain
  // check here followed by recording the failure after bcrypt let a concurrent
  // burst all pass the check at once. Reserving counts in-flight attempts, so
  // at most `limit` attempts can ever be past this point per window, and a
  // locked-out caller never gets to spend server CPU on a hash comparison.
  const ipState = reserveAttempt(ipKey, PER_IP_LIMIT);
  if (!ipState.allowed) return lockedOut(ipState.retryAfterSec);
  const globalState = reserveAttempt(GLOBAL_KEY, GLOBAL_LIMIT);
  if (!globalState.allowed) {
    releaseAttempt(ipKey);
    return lockedOut(globalState.retryAfterSec);
  }

  // Whether this attempt was a real wrong-credentials guess. Anything else
  // (malformed body, setup not done, server error, success) hands both
  // reserved slots back.
  let countsAsFailure = false;
  try {
    const body = await readJsonBody<{ email?: unknown; password?: unknown }>(request);
    const email = body?.email;
    const password = body?.password;

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    if (!password || typeof password !== "string") {
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400 }
      );
    }

    const admin = await getAdminUser();
    if (!admin || !admin.passwordHash) {
      // Not configured yet — point the client at the setup wizard.
      return NextResponse.json({ error: "setup_required" }, { status: 409 });
    }

    const emailOk =
      email.trim().toLowerCase() === (admin.email || "").toLowerCase();
    const passwordOk = await verifyPassword(password, admin.passwordHash);
    if (!emailOk || !passwordOk) {
      countsAsFailure = true;
      // Report the lockout on the attempt that trips it, rather than letting
      // the caller discover it only on their next request. Decided by this
      // attempt's own reservation, not the live bucket: concurrent attempts
      // still in flight have also reserved, so the bucket already looks full
      // to all of them.
      if (ipState.remaining === 0) return lockedOut(ipState.lockoutSec ?? 1);
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    // A real sign-in clears this client's failures, so an operator who mistyped
    // a few times isn't left near the limit for the rest of the window.
    clearRateLimit(ipKey);

    await createSession(admin.id);

    return NextResponse.json({
      message: "Signed in",
      user: { id: admin.id, name: admin.name, email: admin.email },
    });
  } catch (error) {
    const bodyResponse = bodyErrorResponse(error);
    if (bodyResponse) return bodyResponse;
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  } finally {
    if (!countsAsFailure) {
      releaseAttempt(ipKey);
      releaseAttempt(GLOBAL_KEY);
    }
  }
}
