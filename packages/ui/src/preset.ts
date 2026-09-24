/**
 * Shared Tailwind / NativeWind preset.
 *
 * NativeWind (mobile) and Tailwind CSS (web + admin) both accept a `presets`
 * array whose entries look like a partial Tailwind config. Consuming this one
 * preset from every surface guarantees a single source of truth for the brand
 * palette:
 *
 * ```ts
 * // apps/mobile/tailwind.config.js  (NativeWind)
 * // apps/web/tailwind.config.ts     (Tailwind)
 * // apps/admin/tailwind.config.ts   (Tailwind)
 * import { kshemaPreset } from "@kshema/ui";
 * export default { presets: [kshemaPreset], content: [...] };
 * ```
 *
 * The excluded clinical red / hospital blue never appear here (R16.4).
 *
 * Requirements: 16.2, 16.3, 16.4, 22.19.
 */
import { palette, semanticColors } from "./tokens";

/**
 * Minimal structural type for a Tailwind/NativeWind preset. We avoid a hard
 * dependency on `tailwindcss` types so this package stays dependency-light and
 * usable from both the RN and web toolchains.
 */
export interface KshemaThemePreset {
  theme: {
    extend: {
      colors: Record<string, string>;
    };
  };
}

/**
 * Brand colors flattened for Tailwind/NativeWind class generation. Includes
 * both the raw palette (`bg-terracotta`, `text-deep-charcoal`) and the
 * semantic roles (`bg-primary-action`, `text-healthy`) so product code can use
 * whichever reads clearest at the call site.
 */
export const brandColors = {
  // Raw palette (kebab-cased so classes read naturally in markup).
  "sandalwood-cream": palette.sandalwoodCream,
  terracotta: palette.terracotta,
  "deep-charcoal": palette.deepCharcoal,
  "muted-sage-green": palette.mutedSageGreen,
  "soft-amber": palette.softAmber,
  "temple-brass": palette.templeBrass,

  // Semantic roles.
  canvas: semanticColors.canvas,
  "primary-action": semanticColors.primaryAction,
  typography: semanticColors.typography,
  healthy: semanticColors.healthy,
  escalating: semanticColors.escalating,
  celebration: semanticColors.celebration,
} as const;

/**
 * The shared preset. Import into any Tailwind or NativeWind config via
 * `presets: [kshemaPreset]`.
 */
export const kshemaPreset: KshemaThemePreset = {
  theme: {
    extend: {
      colors: { ...brandColors },
    },
  },
};
