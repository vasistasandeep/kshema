/**
 * NativeWind (Tailwind) config for the Kshema Expo app.
 *
 * The brand palette is NOT redefined here — it is imported once from the
 * shared `@kshema/ui` preset (`kshemaPreset`) so mobile, web, and admin all
 * render the exact same Sandalwood Cream / Terracotta / Sage / Amber / Brass
 * tokens, and clinical red / hospital blue are structurally excluded
 * (R16.2, R16.3, R16.4).
 */
const { kshemaPreset } = require("@kshema/ui");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset"), kshemaPreset],
  theme: {
    extend: {},
  },
  plugins: [],
};
