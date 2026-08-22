import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { getAdminUser, verifyPassword } from "@/lib/admin";
import {
  checkRateLimit,
  clearRateLimit,
  clientKey,
  recordFailure,
} from "@/lib/rate-limit";

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
  try {
    const ipKey = `login:${clientKey(request)}`;

    // Check both buckets BEFORE touching bcrypt — a locked-out caller must not
    // get to spend server CPU on a hash comparison.
    const ipState = checkRateLimit(ipKey, PER_IP_LIMIT);
    if (!ipState.allowed) return lockedOut(ipState.retryAfterSec);
    const globalState = checkRateLimit(GLOBAL_KEY, GLOBAL_LIMIT);
    if (!globalState.allowed) return lockedOut(globalState.retryAfterSec);

    const { email, password } = await request.json();

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
      recordFailure(GLOBAL_KEY, GLOBAL_LIMIT);
      const next = recordFailure(ipKey, PER_IP_LIMIT);
      // Report the lockout on the attempt that trips it, rather than letting
      // the caller discover it only on their next request.
      if (!next.allowed) return lockedOut(next.retryAfterSec);
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
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
