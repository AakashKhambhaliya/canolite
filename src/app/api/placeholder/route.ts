import { NextResponse } from "next/server";

/**
 * Placeholder image endpoint for demo/development.
 * Returns a simple SVG placeholder image.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const w = parseInt(url.searchParams.get("w") || "400", 10);
  const h = parseInt(url.searchParams.get("h") || "300", 10);
  const text = url.searchParams.get("text") || `${w}×${h}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#f1f5f9"/>
    <rect x="2" y="2" width="${w - 4}" height="${h - 4}" fill="none" stroke="#e2e8f0" stroke-width="2" rx="8"/>
    <text x="${w / 2}" y="${h / 2}" font-family="system-ui, sans-serif" font-size="${Math.min(w, h) / 10}" fill="#94a3b8" text-anchor="middle" dominant-baseline="central">${text}</text>
  </svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
