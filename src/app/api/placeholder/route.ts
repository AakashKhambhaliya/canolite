import { NextResponse } from "next/server";

/** Escape text before interpolating into XML/SVG markup. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Clamp a query-param dimension to a finite, sane pixel size. */
function clampDimension(raw: string | null, fallback: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(4000, Math.max(1, n));
}

/**
 * Placeholder image endpoint for demo/development. Public/unauthenticated
 * (see src/middleware.ts) — returns a simple SVG placeholder image.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const w = clampDimension(url.searchParams.get("w"), 400);
  const h = clampDimension(url.searchParams.get("h"), 300);
  // Escaped because this is public and unauthenticated: an unescaped `text`
  // interpolated into SVG served as image/svg+xml is a same-origin XSS
  // vector (a crafted <script> in the query string executes on navigation
  // or <object>/<iframe> embedding of this URL).
  const text = escapeXml(url.searchParams.get("text") || `${w}×${h}`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#f1f5f9"/>
    <rect x="2" y="2" width="${w - 4}" height="${h - 4}" fill="none" stroke="#e2e8f0" stroke-width="2" rx="8"/>
    <text x="${w / 2}" y="${h / 2}" font-family="system-ui, sans-serif" font-size="${Math.min(w, h) / 10}" fill="#94a3b8" text-anchor="middle" dominant-baseline="central">${text}</text>
  </svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
