/**
 * Kshema brand design tokens — the single source of truth for color.
 *
 * The approved palette is intentionally warm and calm; clinical/alarm colors
 * are excluded entirely so the product never reads as a medical or panic
 * device (R16.4, R22.20). Both the mobile app (NativeWind) and the web/admin
 * surfaces (Tailwind) consume these same values via {@link kshemaPreset}.
 *
 * Requirements: 16.2, 16.3, 16.4, 22.19.
 */

/**
 * The approved brand palette. Each entry is a `#RRGGBB` hex string.
 *
 * - `sandalwoodCream` — primary canvas / surface (R16.2)
 * - `terracotta`      — primary action (R16.2)
 * - `deepCharcoal`    — typography (R16.2)
 * - `mutedSageGreen`  — healthy / "All Well" states (R16.3)
 * - `softAmber`       — delayed / escalating states (R16.3)
 * - `templeBrass`     — celebration + Sanctuary Shield banner (R22.19, R34.3)
 */
export const palette = {
  sandalwoodCream: "#FDFBF7",
  terracotta: "#C85A32",
  deepCharcoal: "#1F2421",
  mutedSageGreen: "#3D6B52",
  softAmber: "#D9822B",
  templeBrass: "#D4A359",
} as const;

/** A brand palette token name (e.g. `"terracotta"`). */
export type PaletteToken = keyof typeof palette;

/** A brand palette hex value (e.g. `"#C85A32"`). */
export type PaletteValue = (typeof palette)[PaletteToken];

/**
 * Semantic role tokens map UI intent onto the raw palette so product code
 * references meaning ("primaryAction") rather than a specific hex value.
 * This keeps the palette swappable and enforces brand consistency.
 *
 * Requirements: 16.2, 16.3, 22.19.
 */
export const semanticColors = {
  /** Primary app canvas / background surface (R16.2). */
  canvas: palette.sandalwoodCream,
  /** Primary call-to-action (R16.2). */
  primaryAction: palette.terracotta,
  /** Body + heading typography (R16.2). */
  typography: palette.deepCharcoal,
  /** Healthy / "All Well" well-being state (R16.3). */
  healthy: palette.mutedSageGreen,
  /** Delayed or escalating stage indicator (R16.3). */
  escalating: palette.softAmber,
  /** Streak celebrations, milestone badges, and the Sanctuary Shield banner (R22.19, R34.3). */
  celebration: palette.templeBrass,
} as const;

/** A semantic role token name (e.g. `"primaryAction"`). */
export type SemanticColorToken = keyof typeof semanticColors;

/**
 * Colors that are prohibited from the entire UI: clinical red and hospital
 * blue. These are exported so tooling/tests can assert they never appear in
 * the palette or any preset (R16.4).
 */
export const bannedColors = {
  clinicalRed: "#FF0000",
  hospitalBlue: "#0066FF",
} as const;

/** A banned color hex value. */
export type BannedColorValue = (typeof bannedColors)[keyof typeof bannedColors];

/** Normalized (lowercased) set of banned hex values for fast membership checks. */
const bannedColorSet: ReadonlySet<string> = new Set(
  Object.values(bannedColors).map((hex) => hex.toLowerCase()),
);

/**
 * Returns `true` when the supplied hex color is one of the excluded
 * clinical/hospital colors. Case-insensitive.
 */
export function isBannedColor(hex: string): boolean {
  return bannedColorSet.has(hex.trim().toLowerCase());
}
