/**
 * Next.js 14 config for @kshema/admin (the operations console — R21).
 *
 * `transpilePackages` compiles the workspace TypeScript packages from source,
 * matching apps/web. The console talks ONLY to the Fastify API over CORS; no
 * server route proxies a black-box decrypt or live location/audio (R21.6/21.7).
 *
 * OneDrive note (same as apps/web): `.next` is redirected off the synced tree
 * via a directory JUNCTION created by `scripts/predev.mjs`, and webpack's
 * on-disk cache is disabled in dev. `distDir` stays the default relative
 * `.next` because Next rejects an absolute path.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@kshema/types", "@kshema/ui"],
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
