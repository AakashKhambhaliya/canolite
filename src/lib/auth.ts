import { cookies } from "next/headers";
import { db } from "@/db";
import { sessions, users, projects } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";

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

    // Validate session
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.sessionToken, token),
          gt(sessions.expires, new Date())
        )
      )
      .limit(1);

    if (!session) return null;

    // Get user
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) return null;

    // Get first project
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, user.id))
      .limit(1);

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      projectId: project?.id || "",
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
