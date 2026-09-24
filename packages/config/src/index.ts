/**
 * @kshema/config — shared ESLint / Prettier / TypeScript presets plus the
 * custom `no-banned-terms` ESLint rule, consumed by every app and package.
 *
 * The `no-banned-terms` rule enforces the Brand_Lexicon repo-wide: it fails the
 * build on any user-facing string containing a Banned_Term (the eight English
 * terms plus locale equivalents for hi/kn/ta/te), with key-scoped sanctioned
 * exceptions for the public portal's "Dignity Over Surveillance" philosophy
 * tenet — see ./rules/no-banned-terms (Requirements 16.1, 17.4, 28.18, 30.8).
 */
export const CONFIG_PACKAGE = "@kshema/config" as const;

// Shared presets
export { prettierConfig, type PrettierPreset } from "./prettier.js";
export { tsBaseConfig, TS_BASE_EXTENDS, type TsPreset } from "./typescript.js";

// ESLint preset + local plugin
export {
  baseEslintConfig,
  legacyEslintConfig,
  kshemaPlugin,
  PLUGIN_NAME,
  SANCTIONED_TERM_EXCEPTIONS,
  type FlatConfigEntry,
} from "./eslint.js";

// Custom rule + Banned_Term lexicon (full enforcement)
export {
  noBannedTermsRule,
  findBannedTerm,
  DEFAULT_BANNED_TERMS,
  BANNED_TERMS_EN,
  BANNED_TERMS_BY_LOCALE,
  type NoBannedTermsOptions,
} from "./rules/no-banned-terms.js";
