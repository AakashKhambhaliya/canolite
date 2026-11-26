import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  "/login",
  "/setup",
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/setup",
  "/api/v1/", // Public API uses API key auth, not session
  "/api/placeholder",
  "/storage/", // Rendered images / uploads — served publicly by design
];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a state-changing request was issued by this app's own pages.
 *
 * Browsers send Sec-Fetch-Site on every request (modern engines) and Origin on
 * every POST/PUT/PATCH/DELETE. Sec-Fetch-Site is authoritative when present;
 * otherwise Origin must name this host (as the client sees it, so a reverse
 * proxy's X-Forwarded-Host counts, as does APP_URL). A request carrying
 * neither header is not from a browser, so it can't be a CSRF.
 */
function isSameOriginRequest(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  const origin = request.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const add = (value: string | null | undefined) => {
    const host = value?.split(",")[0].trim().toLowerCase();
    if (host) allowed.add(host);
  };
  add(request.headers.get("x-forwarded-host"));
  add(request.headers.get("host"));
  add(request.nextUrl.host);
  try {
    if (process.env.APP_URL) add(new URL(process.env.APP_URL).host);
  } catch {
    /* ignore a malformed APP_URL */
  }
  return allowed.has(originHost);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public API alias: the docs/Playground advertise the clean `/v1/...` URL,
  // but the route handlers live under `/api/v1/...`. Rewrite internally so the
  // documented URL works and is authenticated by API key (not the session
  // redirect below). Must run before the auth checks.
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    const url = request.nextUrl.clone();
    url.pathname = `/api${pathname}`;
    return NextResponse.rewrite(url);
  }

  // CSRF: the dashboard's session cookie is SameSite=Lax, which still rides
  // along on a "simple" cross-origin POST from a SAME-SITE page (a sibling
  // subdomain), and request.json() happily parses a text/plain body. So any
  // state-changing /api call made with the session must come from this
  // origin. /api/v1 is excluded: it authenticates with an API key header,
  // never the cookie.
  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/v1/") &&
    !SAFE_METHODS.has(request.method) &&
    !isSameOriginRequest(request)
  ) {
    return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }

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
