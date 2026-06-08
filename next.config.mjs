/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "playwright",
    "sharp",
    "@electric-sql/pglite",
  ],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
      {
        protocol: "http",
        hostname: "**",
      },
    ],
  },
  webpack: (config) => {
    // Exclude canvas from client-side bundling
    config.externals = [...(config.externals || []), { canvas: "canvas" }];
    return config;
  },
};

export default nextConfig;
