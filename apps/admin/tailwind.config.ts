import type { Config } from "tailwindcss";
import { kshemaPreset } from "@kshema/ui";

/**
 * Tailwind config for @kshema/admin. The brand palette comes exclusively from
 * the shared `@kshema/ui` preset (single source of truth). Clinical red and
 * hospital blue are excluded by construction (R16.4). Escalation and
 * dispatch-failure emphasis uses Soft Amber (`escalating`) — never a red alert
 * indicator.
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
