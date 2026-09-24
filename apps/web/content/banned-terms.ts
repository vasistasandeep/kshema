/**
 * Banned_Term guard for the public brand & trust portal (R30.8, Property 14).
 *
 * The Brand_Lexicon prohibits surveillance/medical/alarm vocabulary from every
 * user-facing string. The custom `no-banned-terms` ESLint rule enforces this
 * statically at build time; this module provides the same term set for runtime
 * assertions and the portal's content tests, including locale equivalents for
 * the five Supported_Languages (en, hi, kn, ta, te).
 *
 * Requirements: 30.8, 16.1, 16.4, 17.4.
 */

/**
 * English Banned_Terms enumerated by the requirements/Brand_Lexicon:
 * Monitoring, Surveillance, Tracking, Patient, Elderly Watch, Supervision,
 * Fall Alarm, Panic Button.
 */
export const BANNED_TERMS_EN: readonly string[] = [
  "monitoring",
  "surveillance",
  "tracking",
  "patient",
  "elderly watch",
  "supervision",
  "fall alarm",
  "panic button",
];

/**
 * Locale equivalents of the core Banned_Terms. These are the literal
 * translations the portal must never render (R17.4). The list is deliberately
 * conservative — it targets the direct surveillance/medical/alarm words so the
 * guard does not produce false positives against ordinary approved copy.
 */
export const BANNED_TERMS_BY_LOCALE: Readonly<Record<string, readonly string[]>> = {
  en: BANNED_TERMS_EN,
  // Hindi
  hi: ["निगरानी", "ट्रैकिंग", "मरीज़", "मरीज", "रोगी", "पैनिक बटन"],
  // Kannada
  kn: ["ಕಣ್ಗಾವಲು", "ಟ್ರ್ಯಾಕಿಂಗ್", "ರೋಗಿ", "ಪ್ಯಾನಿಕ್ ಬಟನ್"],
  // Tamil
  ta: ["கண்காணிப்பு", "டிராக்கிங்", "நோயாளி", "பானிக் பட்டன்"],
  // Telugu
  te: ["నిఘా", "ట్రాకింగ్", "రోగి", "పానిక్ బటన్"],
};

/**
 * Sanctioned exceptions where a Banned_Term appears intentionally to *reject*
 * that concept rather than describe the product. R30.1 mandates the verbatim
 * "Dignity Over Surveillance" tenet and an explanation of why ambient telemetry
 * *replaces* surveillance/tracking — so those specific philosophy strings name
 * the banned concepts precisely to disavow them.
 *
 * The exception is scoped to individual catalog keys (not global) so the guard
 * stays strict everywhere else. Terms are matched case-insensitively.
 */
export const SANCTIONED_TERM_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  "philosophy.heading": ["surveillance", "निगरानी", "ಕಣ್ಗಾವಲು", "கண்காணிப்பு", "నిఘా"],
  "philosophy.lede": ["surveillance", "tracking", "निगरानी", "ಕಣ್ಗಾವಲು", "கண்காணிப்பு", "నిఘా"],
};

/** Every Banned_Term across every locale, de-duplicated and lowercased. */
export const ALL_BANNED_TERMS: readonly string[] = Array.from(
  new Set(
    Object.values(BANNED_TERMS_BY_LOCALE)
      .flat()
      .map((t) => t.toLowerCase()),
  ),
);

/**
 * Returns the first Banned_Term contained in `text` (case-insensitive
 * substring match), or `undefined` when the text is clean. When `locale` is
 * supplied, both that locale's terms and the English terms are checked;
 * otherwise the full multi-locale set is used.
 */
export function findBannedTerm(text: string, locale?: string): string | undefined {
  const haystack = text.toLowerCase();
  const terms =
    locale && BANNED_TERMS_BY_LOCALE[locale]
      ? [...BANNED_TERMS_BY_LOCALE[locale]!, ...BANNED_TERMS_EN]
      : ALL_BANNED_TERMS;
  for (const term of terms) {
    if (term.length > 0 && haystack.includes(term.toLowerCase())) return term;
  }
  return undefined;
}

/** Convenience predicate: does `text` contain any Banned_Term? */
export function containsBannedTerm(text: string, locale?: string): boolean {
  return findBannedTerm(text, locale) !== undefined;
}

/**
 * Catalog-aware Banned_Term check for a specific `{key, value}` entry. Returns
 * the offending term, or `undefined` when clean. A term listed under
 * {@link SANCTIONED_TERM_EXCEPTIONS} for that key is permitted (the philosophy
 * tenet naming surveillance/tracking to reject them — R30.1), but any *other*
 * Banned_Term in that same string is still flagged.
 */
export function findBannedTermForKey(
  key: string,
  value: string,
  locale?: string,
): string | undefined {
  const allowed = new Set(
    (SANCTIONED_TERM_EXCEPTIONS[key] ?? []).map((t) => t.toLowerCase()),
  );
  const haystack = value.toLowerCase();
  const terms =
    locale && BANNED_TERMS_BY_LOCALE[locale]
      ? [...BANNED_TERMS_BY_LOCALE[locale]!, ...BANNED_TERMS_EN]
      : ALL_BANNED_TERMS;
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.length > 0 && !allowed.has(lower) && haystack.includes(lower)) {
      return term;
    }
  }
  return undefined;
}
