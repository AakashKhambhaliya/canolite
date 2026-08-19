/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "playwright",
    "sharp",
    "@electric-sql/pglite",
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
  webpack: (config) => {
    // Exclude canvas from client-side bundling
    config.externals = [...(config.externals || []), { canvas: "canvas" }];
    return config;
  },
};

export default nextConfig;
