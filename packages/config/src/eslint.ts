/**
 * @kshema/config — shared ESLint preset + local plugin.
 *
 * Exposes:
 *  - {@link kshemaPlugin}: an ESLint plugin bundling the custom
 *    `no-banned-terms` rule (see ./rules/no-banned-terms).
 *  - {@link baseEslintConfig}: a flat-config array every app/package extends,
 *    registering the plugin and turning the rule on.
 *
 * Consumed from a package's `eslint.config.js`:
 *
 *   import { baseEslintConfig } from "@kshema/config";
 *   export default [...baseEslintConfig];
 *
 * The objects match ESLint's flat-config shape without importing `eslint`,
 * keeping this package dependency-light. ESLint reads the plain structures.
 */
import { noBannedTermsRule } from "./rules/no-banned-terms.js";

/** ESLint plugin id under which the custom rules are registered. */
export const PLUGIN_NAME = "kshema" as const;

/**
 * Key-scoped sanctioned Banned_Term exceptions applied repo-wide. Only the
 * public portal's "Dignity Over Surveillance" philosophy tenet may name the
 * surveillance/tracking concepts it disavows (Requirement 30.1). The exception
 * is bounded to these specific i18n catalog keys; every other key and string
 * remains strict. Kept in sync with the runtime guard's
 * `SANCTIONED_TERM_EXCEPTIONS` in `apps/web/content/banned-terms.ts`.
 */
export const SANCTIONED_TERM_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  "philosophy.heading": ["surveillance", "निगरानी", "ಕಣ್ಗಾವಲು", "கண்காணிப்பு", "నిఘా"],
  "philosophy.lede": [
    "surveillance",
    "tracking",
    "निगरानी",
    "ट्रैकिंग",
    "ಕಣ್ಗಾವಲು",
    "ಟ್ರ್ಯಾಕಿಂಗ್",
    "கண்காணிப்பு",
    "டிராக்கிங்",
    "నిఘా",
    "ట్రాకింగ్",
  ],
};

/** The local ESLint plugin bundling Kshema's custom rules. */
export const kshemaPlugin = {
  rules: {
    "no-banned-terms": noBannedTermsRule,
  },
} as const;

/** A single flat-config entry. Loosely typed to avoid an `eslint` dependency. */
export interface FlatConfigEntry {
  readonly plugins?: Record<string, unknown>;
  readonly rules?: Record<string, unknown>;
  readonly ignores?: readonly string[];
  readonly files?: readonly string[];
}

/**
 * The base flat-config array shared by every app/package. Registers the
 * `kshema` plugin and enables `no-banned-terms` as a build-failing error with
 * the full Banned_Term lexicon and the bounded philosophy-tenet exceptions.
 */
export const baseEslintConfig: readonly FlatConfigEntry[] = [
  {
    ignores: ["dist/**", ".next/**", "build/**", "coverage/**", "node_modules/**"],
  },
  {
    plugins: {
      [PLUGIN_NAME]: kshemaPlugin,
    },
    rules: {
      [`${PLUGIN_NAME}/no-banned-terms`]: [
        "error",
        { exceptions: SANCTIONED_TERM_EXCEPTIONS },
      ],
    },
  },
];

/**
 * Legacy (`.eslintrc`) equivalent of {@link baseEslintConfig} for apps still on
 * eslintrc config (e.g. Next.js apps consuming `next lint`). Spread the plugin
 * registration and rule into an `.eslintrc`-shaped object:
 *
 *   const { legacyEslintConfig } = require("@kshema/config");
 *   module.exports = { extends: ["next/core-web-vitals"], ...legacyEslintConfig };
 */
export const legacyEslintConfig = {
  plugins: [PLUGIN_NAME],
  rules: {
    [`${PLUGIN_NAME}/no-banned-terms`]: [
      "error",
      { exceptions: SANCTIONED_TERM_EXCEPTIONS },
    ],
  },
} as const;
