import type { Config } from "tailwindcss";
import { kshemaPreset } from "@kshema/ui";

/**
 * Tailwind config for @kshema/web. The brand palette comes exclusively from the
 * shared `@kshema/ui` preset (single source of truth; clinical red / hospital
 * blue are excluded — R16.4). The responder portal inlines its critical CSS
 * (see `app/emergency/[token]/critical-css.ts`) so it can render fast on 3G
 * without waiting for the full stylesheet, but the classes still resolve here.
 */
const config: Config = {
  presets: [kshemaPreset as unknown as Partial<Config>],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
