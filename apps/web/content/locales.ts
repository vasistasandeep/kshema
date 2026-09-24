/**
 * Supported_Language definitions for the public brand & trust portal (R30.5).
 *
 * Every public page must be available in all five languages. This module is
 * the single source of truth for the locale set and its display metadata; the
 * i18n catalogs (see {@link ./catalog}) are keyed by these codes.
 *
 * Requirements: 30.5, 17.1, 17.2.
 */

/** The five Supported_Languages: English, Hindi, Kannada, Tamil, Telugu. */
export const SUPPORTED_LOCALES = ["en", "hi", "kn", "ta", "te"] as const;

/** A Supported_Language BCP-47-style short code. */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The default locale used when no preference is detected. */
export const DEFAULT_LOCALE: Locale = "en";

/** Human-readable metadata for a locale (endonym shown in the language switch). */
export interface LocaleMeta {
  readonly code: Locale;
  /** English name of the language. */
  readonly englishName: string;
  /** Native (endonym) name shown in the language switcher. */
  readonly nativeName: string;
  /** Text direction — all five Supported_Languages are left-to-right. */
  readonly dir: "ltr";
}

/** Display metadata for each Supported_Language. */
export const LOCALE_META: Readonly<Record<Locale, LocaleMeta>> = {
  en: { code: "en", englishName: "English", nativeName: "English", dir: "ltr" },
  hi: { code: "hi", englishName: "Hindi", nativeName: "हिन्दी", dir: "ltr" },
  kn: { code: "kn", englishName: "Kannada", nativeName: "ಕನ್ನಡ", dir: "ltr" },
  ta: { code: "ta", englishName: "Tamil", nativeName: "தமிழ்", dir: "ltr" },
  te: { code: "te", englishName: "Telugu", nativeName: "తెలుగు", dir: "ltr" },
};

/** Type guard: is the supplied string a Supported_Language code? */
export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolves a browser `Accept-Language`-style value (or any candidate string)
 * to a Supported_Language, falling back to {@link DEFAULT_LOCALE}. Only the
 * primary subtag is considered (e.g. `hi-IN` → `hi`).
 */
export function resolveLocale(candidate: string | null | undefined): Locale {
  if (!candidate) return DEFAULT_LOCALE;
  for (const part of candidate.split(",")) {
    const primary = part.trim().split(";")[0]?.trim().split("-")[0]?.toLowerCase();
    if (primary && isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
