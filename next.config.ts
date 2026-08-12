import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Suppress Next.js's built-in request logging — we use our own
  // pino-based server logger (lib/services/server-logger.ts) instead.
  logging: {
    fetches: { fullUrl: false, hmrRefreshes: false },
    incomingRequests: false,
  },
};

export default nextConfig;
