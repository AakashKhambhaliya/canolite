import { cookies, headers } from "next/headers";
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

  // Mark the cookie `Secure` only when the BROWSER is on HTTPS. That's the
  // scheme that decides whether the cookie is kept — a Secure cookie sent to an
  // http:// origin is silently dropped, leaving the user on the login page
  // after a successful sign-in. (Keying off NODE_ENV would break every
  // plain-HTTP install, e.g. http://server-ip:3000.)
  //
  // `Origin` comes from the browser itself and is sent on same-origin POSTs, so
  // it is the authoritative signal. X-Forwarded-Proto is only a fallback: it
  // describes the proxy→app hop, and a proxy configured for an HTTPS domain can
  // report "https" even while this particular visitor is on plain HTTP.
  const hdrs = await headers();
  const browserOrigin = hdrs.get("origin") || hdrs.get("referer") || "";
  const forwardedProto = hdrs
    .get("x-forwarded-proto")
    ?.split(",")[0]
    .trim()
    .toLowerCase();

  const isHttps = browserOrigin.startsWith("https://")
    ? true
    : browserOrigin.startsWith("http://")
    ? false
    : forwardedProto === "https";

  const cookieStore = await cookies();
  cookieStore.set("session_token", sessionToken, {
    httpOnly: true,
    secure: isHttps,
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
    const cookieStore = await cookies();
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
