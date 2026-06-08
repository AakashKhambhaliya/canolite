import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST() {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get("session_token")?.value;

    if (token) {
      await db.delete(sessions).where(eq(sessions.sessionToken, token));
      cookieStore.delete("session_token");
    }

    return NextResponse.json({ message: "Logged out" });
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
