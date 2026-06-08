import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { createSession } from "@/lib/auth";
import { getAdminUser, hashPassword, isSetupComplete } from "@/lib/admin";

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
  try {
    if (await isSetupComplete()) {
      return NextResponse.json(
        { error: "Setup has already been completed." },
        { status: 409 }
      );
    }

    const { email, password } = await request.json();

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

    return NextResponse.json({
      message: "Setup complete",
      user: { id: admin.id, email: cleanEmail },
    });
  } catch (error) {
    console.error("Setup error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
