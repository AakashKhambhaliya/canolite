import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  "/login",
  "/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/setup",
  "/api/v1/", // Public API uses API key auth, not session
  "/api/placeholder",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Allow Next.js internals and genuine static asset files (by extension).
  // Note: a broad `pathname.includes(".")` would let any dotted path skip the
  // auth gate, so we match a known static-asset extension allowlist instead.
  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    /\.(?:ico|png|jpg|jpeg|gif|webp|svg|css|js|map|txt|woff2?|ttf|otf)$/.test(
      pathname
    )
  ) {
    return NextResponse.next();
  }

  // Check for session cookie on protected routes
  const sessionToken = request.cookies.get("session_token")?.value;

  if (!sessionToken) {
    // Redirect to login for page routes
    if (!pathname.startsWith("/api/")) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    // Return 401 for API routes
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Session exists — proceed (server-side will validate it)
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
