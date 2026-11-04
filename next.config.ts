import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg", "bcryptjs"],
  devIndicators: false,
  images: { unoptimized: true },
};

export default nextConfig;
