import { bootstrapAuthorized } from "@/lib/security/bootstrap";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { createSession } from "@/lib/auth";
import { getAdminUser, hashPassword, isSetupComplete } from "@/lib/admin";
import { writeInstanceMarker } from "@/db/seed-data";
import { clientKey, releaseAttempt, reserveAttempt } from "@/lib/rate-limit";
import { bodyErrorResponse, readJsonBody } from "@/lib/json-body";

const SETUP_PER_IP_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
const SETUP_GLOBAL_LIMIT = { limit: 50, windowMs: 15 * 60 * 1000 };
const SETUP_GLOBAL_KEY = "setup:global";

function setupLockedOut(retryAfterSec: number) {
  return NextResponse.json(
    { error: `Too many setup attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}

/** Report whether the admin account has been configured. */
export async function GET() {
  try {
    const configured = await isSetupComplete();
    return NextResponse.json({ configured });
  } catch (error) {
    console.error("Setup status error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * First-run setup: set the admin email + password. Allowed only once — once the
 * account is configured this returns 409 (use the in-app password change with
 * the current password instead).
 */
export async function POST(request: Request) {
  // The setup token is a bearer secret on an unauthenticated endpoint; throttle
  // guesses the same way login does (reserved synchronously, so a concurrent
  // burst can't slip past the check).
  const ipKey = `setup:${clientKey(request)}`;
  const ipState = reserveAttempt(ipKey, SETUP_PER_IP_LIMIT);
  if (!ipState.allowed) return setupLockedOut(ipState.retryAfterSec);
  const globalState = reserveAttempt(SETUP_GLOBAL_KEY, SETUP_GLOBAL_LIMIT);
  if (!globalState.allowed) {
    releaseAttempt(ipKey);
    return setupLockedOut(globalState.retryAfterSec);
  }
  let badToken = false;

  try {
    if (await isSetupComplete()) {
      return NextResponse.json(
        { error: "Setup has already been completed." },
        { status: 409 }
      );
    }

    const body = await readJsonBody<Record<string, unknown>>(request);
    const { email, password, setupToken } = body ?? {};
    if (!bootstrapAuthorized(setupToken)) {
      badToken = true;
      return NextResponse.json({ error: "Invalid setup token. Use CANOLITE_SETUP_TOKEN, or the one-time token printed in the server log at startup." }, { status: 403 });
    }

    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return NextResponse.json(
        { error: "A valid email is required" },
        { status: 400 }
      );
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const admin = await getAdminUser();
    if (!admin) {
      return NextResponse.json(
        { error: "Admin account not initialized. Restart the server." },
        { status: 500 }
      );
    }

    const passwordHash = await hashPassword(password);
    // Conditional update (passwordHash still NULL) closes the setup race: only
    // the first concurrent request succeeds.
    const updated = await db
      .update(users)
      .set({ email: cleanEmail, passwordHash, updatedAt: new Date() })
      .where(and(eq(users.id, admin.id), isNull(users.passwordHash)))
      .returning({ id: users.id });

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "Setup has already been completed." },
        { status: 409 }
      );
    }

    // Sign the new admin in immediately.
    await createSession(admin.id);

    // Persist an instance marker now that the admin is configured, so a later
    // volume loss/mismatch is detectable at boot.
    writeInstanceMarker();

    return NextResponse.json({
      message: "Setup complete",
      user: { id: admin.id, email: cleanEmail },
    });
  } catch (error) {
    const bodyResponse = bodyErrorResponse(error);
    if (bodyResponse) return bodyResponse;
    console.error("Setup error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  } finally {
    if (!badToken) {
      releaseAttempt(ipKey);
      releaseAttempt(SETUP_GLOBAL_KEY);
    }
  }
}
