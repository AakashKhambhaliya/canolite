import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { getAdminUser, verifyPassword } from "@/lib/admin";

/**
 * Single-admin sign in.
 *
 * Credentials are stored on the admin user row (set during first-run setup or
 * via the ADMIN_EMAIL/ADMIN_PASSWORD env vars). If setup hasn't run yet, the
 * client is told to redirect to the setup wizard.
 */
export async function POST(request: Request) {
  try {
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
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

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
