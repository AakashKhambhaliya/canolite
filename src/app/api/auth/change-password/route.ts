import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getAdminUser, hashPassword, verifyPassword } from "@/lib/admin";

/**
 * Change the admin password. Requires an authenticated session AND the current
 * password (re-verifies the operator). Optionally updates the email too.
 */
export async function POST(request: Request) {
  try {
    const session = await getCurrentUser();
    if (!session) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { currentPassword, newPassword, email } = await request.json();

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Current and new password are required" },
        { status: 400 }
      );
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return NextResponse.json(
        { error: "New password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const admin = await getAdminUser();
    if (!admin || !admin.passwordHash) {
      return NextResponse.json(
        { error: "Admin account not configured" },
        { status: 400 }
      );
    }

    const ok = await verifyPassword(currentPassword, admin.passwordHash);
    if (!ok) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401 }
      );
    }

    const updates: Record<string, unknown> = {
      passwordHash: await hashPassword(newPassword),
      updatedAt: new Date(),
    };

    // Allow updating the email alongside the password change.
    if (typeof email === "string" && email.trim()) {
      const clean = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        return NextResponse.json(
          { error: "A valid email is required" },
          { status: 400 }
        );
      }
      updates.email = clean;
    }

    await db.update(users).set(updates).where(eq(users.id, admin.id));

    return NextResponse.json({ message: "Password updated" });
  } catch (error) {
    console.error("Change password error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
