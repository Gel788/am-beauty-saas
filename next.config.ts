import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "bcryptjs"],
  devIndicators: false,
  images: { unoptimized: true },
};

export default nextConfig;
