/**
 * @kshema/ui — brand design tokens + shared primitives.
 *
 * The approved palette (Sandalwood Cream, Terracotta, Deep Charcoal, Muted
 * Sage Green, Soft Amber, Temple Brass) is defined once in {@link ./tokens}
 * and exposed to both NativeWind (mobile) and Tailwind (web/admin) via the
 * shared {@link kshemaPreset}. Clinical red and hospital blue are excluded
 * from every export (R16.4).
 *
 * Requirements: 16.2, 16.3, 16.4, 22.19.
 */
export const UI_PACKAGE = "@kshema/ui" as const;

export {
  palette,
  semanticColors,
  bannedColors,
  isBannedColor,
} from "./tokens";
export type {
  PaletteToken,
  PaletteValue,
  SemanticColorToken,
  BannedColorValue,
} from "./tokens";

export { kshemaPreset, brandColors } from "./preset";
export type { KshemaThemePreset } from "./preset";
