import { cookies } from "next/headers";
import { db } from "@/db";
import { sessions, users, projects } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { generateToken } from "@/lib/utils";

/**
 * Create a 30-day session for a user and set the session cookie.
 */
export async function createSession(userId: string): Promise<void> {
  const sessionToken = generateToken(48);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ sessionToken, userId, expires });
  cookies().set("session_token", sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
    path: "/",
  });
}

export interface AuthUser {
  id: string;
  name: string | null;
  email: string;
  projectId: string;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get("session_token")?.value;

    if (!token) return null;

    // Validate the session and load the user + project in one query.
    const [row] = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        projectId: projects.id,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .leftJoin(projects, eq(projects.userId, users.id))
      .where(
        and(eq(sessions.sessionToken, token), gt(sessions.expires, new Date()))
      )
      .limit(1);

    if (!row) return null;

    return {
      id: row.userId,
      name: row.name,
      email: row.email,
      projectId: row.projectId || "",
    };
  } catch (error) {
    console.error("Auth error:", error);
    return null;
  }
}

export async function requireAuth(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  return user;
}
