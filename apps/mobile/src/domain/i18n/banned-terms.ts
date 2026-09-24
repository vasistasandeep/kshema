/**
 * Banned_Term list for Property 14 / R16.1 / R17.4, extended across every
 * Supported_Language.
 *
 * A Banned_Term is a user-facing string prohibited by the Brand_Lexicon
 * because it makes the experience feel clinical or surveillant. The spec
 * enumerates the English terms (R16.1); this module also enumerates the locale
 * equivalents in Hindi, Kannada, Tamil, and Telugu so the runtime property
 * test (Property 14) can preserve lexicon meaning "across every
 * Supported_Language" (R17.4), not just English.
 *
 * Exports are namespaced (`I18N_*`, `findLocaleBannedTerms`, `isLexiconClean`)
 * to compose cleanly alongside the English-only `BANNED_TERMS` guards already
 * defined in `disclaimer.ts` and `ui-presentation.ts`.
 *
 * These strings are matched case-insensitively as substring checks against
 * every catalog entry in every locale.
 */

/** The canonical English Banned_Terms enumerated by R16.1. */
export const BANNED_TERMS_EN = [
  "Monitoring",
  "Surveillance",
  "Tracking",
  "Patient",
  "Elderly Watch",
  "Supervision",
  "Fall Alarm",
  "Panic Button",
] as const;

/**
 * Locale equivalents of the Banned_Terms. Preserving lexicon meaning across
 * languages (R17.4) means a translation must not smuggle a banned concept in
 * via its native word. These lists back the "and locale equivalents" clause of
 * Property 14.
 */
export const I18N_BANNED_TERMS_BY_LOCALE: Readonly<
  Record<string, readonly string[]>
> = {
  en: BANNED_TERMS_EN,
  // Hindi
  hi: [
    "निगरानी", // monitoring / surveillance
    "ट्रैकिंग", // tracking
    "मरीज", // patient
    "मरीज़", // patient (nuqta variant)
    "रोगी", // patient
    "पैनिक बटन", // panic button
    "गिरने का अलार्म", // fall alarm
  ],
  // Kannada
  kn: [
    "ಕಣ್ಗಾವಲು", // surveillance / monitoring
    "ಟ್ರ್ಯಾಕಿಂಗ್", // tracking
    "ರೋಗಿ", // patient
    "ಪ್ಯಾನಿಕ್ ಬಟನ್", // panic button
  ],
  // Tamil
  ta: [
    "கண்காணிப்பு", // surveillance / monitoring
    "கண்காணித்தல்", // tracking
    "நோயாளி", // patient
    "பீதி பொத்தான்", // panic button
  ],
  // Telugu
  te: [
    "నిఘా", // surveillance / monitoring
    "ట్రాకింగ్", // tracking
    "రోగి", // patient
    "పానిక్ బటన్", // panic button
  ],
};

/** Every banned term across every locale, flattened for global scans. */
export const I18N_ALL_BANNED_TERMS: readonly string[] = Object.values(
  I18N_BANNED_TERMS_BY_LOCALE,
).flat();

/**
 * Return the Banned_Terms found within a candidate user-facing string.
 * Matching is case-insensitive and substring-based so that inflected or
 * concatenated forms are still caught. Scans the full multi-locale term set by
 * default.
 */
export function findLocaleBannedTerms(
  text: string,
  terms: readonly string[] = I18N_ALL_BANNED_TERMS,
): string[] {
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term.toLowerCase()));
}

/** Whether a candidate string contains no Banned_Term (Property 14). */
export function isLexiconClean(
  text: string,
  terms: readonly string[] = I18N_ALL_BANNED_TERMS,
): boolean {
  return findLocaleBannedTerms(text, terms).length === 0;
}
