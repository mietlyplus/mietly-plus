import type { NextConfig } from "next";

// On a Preview build that has a backend proxy configured, the browser should call
// its own origin (see app/api/[...path]/route.ts) rather than the API base URL
// that is shared with production. A NEW variable carries that decision, so the
// shared NEXT_PUBLIC_API_BASE_URL is never overridden or edited.
const usePreviewBackendProxy =
  process.env.VERCEL_ENV === "preview" && Boolean(process.env.PREVIEW_BACKEND_PROXY_URL);

const nextConfig: NextConfig = {
  async headers() {
    // Admin pages must never be indexed, whatever robots.txt says.
    return [{ source: "/admin/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
  env: usePreviewBackendProxy ? { NEXT_PUBLIC_API_MODE: "preview-proxy" } : {},
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
      },
      {
        protocol: "https",
        hostname: "www.grover.com",
      },
      {
        protocol: "https",
        hostname: "images.ctfassets.net",
      },
    ],
  },
};

export default nextConfig;
