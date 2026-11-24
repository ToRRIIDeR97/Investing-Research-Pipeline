import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable server actions for form handling
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  // The XBRL warehouse (services/xbrl) is a separate Python service; keep it out of server file traces.
  outputFileTracingExcludes: { "*": ["services/**"] },
  // No page may be framed, so the approval buttons can't be overlaid by another site.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ],
    }];
  },
};

export default nextConfig;
