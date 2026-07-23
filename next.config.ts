import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "standalone",
  // Let the public domain reach dev-only assets/HMR when `next dev` is
  // exposed through the Cloudflare tunnel (bun run tunnel:dev). Dev-only
  // setting; production builds ignore it.
  allowedDevOrigins: process.env.DOMAIN ? [process.env.DOMAIN] : [],
};

export default nextConfig;
