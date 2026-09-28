/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@kshema/types", "@kshema/ui"],
  env: {
    KSHEMA_API_BASE_URL: process.env.KSHEMA_API_BASE_URL ?? "",
    NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE ?? "true",
  },
};
export default nextConfig;
