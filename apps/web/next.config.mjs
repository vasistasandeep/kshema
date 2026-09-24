/**
 * Next.js 14 config for @kshema/web.
 *
 * `transpilePackages` compiles the workspace TypeScript packages
 * (`@kshema/types`, `@kshema/ui`) from source. The emergency responder route
 * opts into the Edge runtime per-route, so no global runtime override is needed.
 *
 * OneDrive note: this workspace lives under a OneDrive-synced folder, whose
 * placeholder/reparse-point behaviour breaks Next's `.next` cache management
 * (EINVAL readlink) and webpack's on-disk cache ("not valid JSON"). Two fixes:
 *   1. `.next` is redirected out of the synced tree via a directory JUNCTION
 *      created by `scripts/predev.mjs` (runs automatically before dev/build);
 *   2. webpack's persistent filesystem cache is disabled in dev (in-memory).
 * `distDir` intentionally stays the default relative `.next` (Next rejects an
 * absolute path) — the junction is what moves the bytes off OneDrive.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@kshema/types", "@kshema/ui"],
  env: {
    KSHEMA_API_BASE_URL: process.env.KSHEMA_API_BASE_URL ?? "",
  },
  webpack(config, { dev }) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    if (dev) {
      config.cache = { type: "memory" };
    }
    return config;
  },
};

export default nextConfig;
