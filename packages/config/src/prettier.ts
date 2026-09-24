/**
 * @kshema/config — shared Prettier preset.
 *
 * Every app/package consumes this by re-exporting it from a local
 * `prettier.config.js` / `.prettierrc.cjs`, e.g.:
 *
 *   module.exports = require("@kshema/config").prettierConfig;
 *
 * The shape matches Prettier's `Config` type without importing `prettier`
 * (keeping this package dependency-light); Prettier reads the plain object.
 */
export interface PrettierPreset {
  readonly printWidth: number;
  readonly tabWidth: number;
  readonly useTabs: boolean;
  readonly semi: boolean;
  readonly singleQuote: boolean;
  readonly quoteProps: "as-needed" | "consistent" | "preserve";
  readonly trailingComma: "none" | "es5" | "all";
  readonly bracketSpacing: boolean;
  readonly arrowParens: "always" | "avoid";
  readonly endOfLine: "lf" | "crlf" | "cr" | "auto";
}

/**
 * The canonical Kshema Prettier configuration. Matches the formatting the
 * scaffolded source in this repo already uses (double quotes, semicolons,
 * 2-space indent, trailing commas, LF line endings).
 */
export const prettierConfig: PrettierPreset = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
};
