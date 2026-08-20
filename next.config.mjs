import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Largest upload any route accepts, in MB. `middleware.ts` matches every path
// except _next/static, _next/image and favicon.ico — /api/upload included — and
// Next buffers a matched request's body with a 10 MB cap by default. A larger
// video was silently TRUNCATED at 10 MB, so `request.formData()` threw
// "Failed to parse body as FormData" and the upload failed with an opaque 500.
// Keep this ceiling at or above the limits the upload route enforces itself
// (MAX_VIDEO_UPLOAD_MB / MAX_UPLOAD_MB), with headroom for multipart overhead,
// so oversized files get the route's own 400 instead of a truncated body.
const maxUploadMb = Math.max(
  Number(process.env.MAX_VIDEO_UPLOAD_MB) || 100,
  Number(process.env.MAX_UPLOAD_MB) || 10
);
const middlewareBodyLimitMb = Math.ceil(maxUploadMb * 1.1) + 1;

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    middlewareClientMaxBodySize: `${middlewareBodyLimitMb}mb`,
  },
  // Pin file tracing to this project. Next infers the root by walking up
  // for lockfiles, and an unrelated package-lock.json in a parent dir (e.g.
  // the user's home) makes it trace the wrong tree and warn on every build.
  outputFileTracingRoot: __dirname,
  // `npm run lint` and `npx tsc --noEmit` are run explicitly in CI/release
  // checks. Skipping the duplicate build-time pass keeps production builds from
  // doing the same expensive work twice, especially now the app carries native
  // embedded-Postgres optional packages.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: [
    "playwright",
    "sharp",
    "embedded-postgres",
    // Both of these export the ABSOLUTE PATH of a bundled native binary,
    // resolved from their own __dirname. Bundling them rewrites __dirname to
    // the emitted chunk's directory, so the path became
    // `.next/server/vendor-chunks/bin/darwin/arm64/ffprobe` and every video
    // upload died with ENOENT. They must stay external to keep pointing at the
    // real binaries inside node_modules.
    "ffmpeg-static",
    "ffprobe-static",
  ],
  // `next/image` is not used anywhere in this app — every image is a plain
  // <img> pointing at /storage. The previous `hostname: "**"` on both http and
  // https left Next's built-in optimizer wide open: /_next/image?url=<anything>
  // is deliberately excluded from the middleware matcher, so it was an
  // unauthenticated "fetch any URL and hand it to libvips" endpoint — an SSRF
  // vector and an open image-resizing proxy for anyone who found the instance.
  // No remote patterns means the optimizer rejects off-origin URLs outright.
  images: {
    unoptimized: true,
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        // The renderer paints these files into a <canvas> and exports it with
        // toDataURL(). Its page is built with setContent(), so it has an OPAQUE
        // origin — every /storage image is cross-origin, and drawing one
        // without CORS permanently taints the canvas ("Tainted canvases may not
        // be exported"), which is what failed MP4 export on the video frames.
        //
        // This must live here rather than in the /storage route handler: with
        // STORAGE_DIR at its default the files sit under public/ and are served
        // by Next's STATIC handler, which never reaches that route. Declaring
        // it here covers both paths with one rule.
        //
        // /storage is already unauthenticated and public by design (see
        // PUBLIC_ROUTES in middleware.ts), so permitting cross-origin reads of
        // bytes anyone can already GET does not widen access.
        source: "/storage/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
  webpack: (config) => {
    // Exclude canvas from client-side bundling
    config.externals = [...(config.externals || []), { canvas: "canvas" }];
    return config;
  },
};

export default nextConfig;
