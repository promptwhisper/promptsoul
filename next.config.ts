import type { NextConfig } from "next";

const development = process.env.NODE_ENV !== "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  // PixiJS 6 compiles WebGL uniform sync functions at runtime and therefore
  // needs unsafe-eval; external SDK bytes remain pinned by SRI in the loader.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cubism.live2d.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  `connect-src 'self'${development ? " ws:" : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Licensed models and local AI output must be mounted beside a self-hosted
  // server, never copied by Next's NFT/standalone deployment tracing.
  outputFileTracingExcludes: {
    "/*": [
      "./models/**/*",
      "./local-assets/**/*",
      "./model.config.json",
      "./motion-defs/generated/**/*",
      "./tmp-verify/**/*",
      "./.env*",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
