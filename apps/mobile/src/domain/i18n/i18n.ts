/**
 * Framework-agnostic i18n engine (R17.1, R17.2).
 *
 * Five locale catalogs (en, hi, kn, ta, te) back all UI strings. This module
 * is pure TypeScript with no React Native dependency, so the catalog logic is
 * typechecked and unit/property-tested under Node in CI; the React UI simply
 * consumes `createTranslator`/`Translator` to render text.
 *
 * Selecting a Supported_Language swaps the active catalog so that a subsequent
 * `t(key)` returns text in that language — this is the pure primitive the UI
 * uses to re-render all user-facing text on language change (R17.2).
 */
import type { Catalog, MessageKey } from "./keys.js";
import { en } from "./catalogs/en.js";
import { hi } from "./catalogs/hi.js";
import { kn } from "./catalogs/kn.js";
import { ta } from "./catalogs/ta.js";
import { te } from "./catalogs/te.js";

/** ISO-639-1 codes for the five Supported_Languages (R17.1). */
export const SUPPORTED_LANGUAGES = ["en", "hi", "kn", "ta", "te"] as const;

/** A Supported_Language code. */
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** The default locale used before a User selects a language. */
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

/** The catalog registry: one complete `Catalog` per Supported_Language. */
export const CATALOGS: Readonly<Record<SupportedLanguage, Catalog>> = {
  en,
  hi,
  kn,
  ta,
  te,
};

/** Type guard: whether an arbitrary string is a Supported_Language. */
export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Resolve a requested language to a Supported_Language, falling back to the
 * default when the request is unsupported (R17.1). Accepts region-tagged codes
 * (e.g. "hi-IN") by taking the primary subtag.
 */
export function resolveLanguage(
  requested: string | null | undefined,
): SupportedLanguage {
  if (!requested) return DEFAULT_LANGUAGE;
  const primary = requested.split("-")[0]?.toLowerCase() ?? "";
  return isSupportedLanguage(primary) ? primary : DEFAULT_LANGUAGE;
}

/**
 * Look up a single key in a specific locale (R17.2). Because every catalog is
 * a total `Record<MessageKey, string>`, the value is always present for a
 * valid key and language — no English fallback leaks through.
 */
export function translate(language: SupportedLanguage, key: MessageKey): string {
  return CATALOGS[language][key];
}

/** A bound translator for one active language. */
export interface Translator {
  /** The language this translator renders. */
  readonly language: SupportedLanguage;
  /** Translate a key into the active language. */
  readonly t: (key: MessageKey) => string;
  /**
   * Return a new Translator bound to a different language. Selecting a language
   * re-renders all text because callers re-read every string through the new
   * translator (R17.2).
   */
  readonly setLanguage: (next: SupportedLanguage) => Translator;
}

/** Create a `Translator` bound to the given (or default) language. */
export function createTranslator(
  language: SupportedLanguage = DEFAULT_LANGUAGE,
): Translator {
  return {
    language,
    t: (key: MessageKey) => translate(language, key),
    setLanguage: (next: SupportedLanguage) => createTranslator(next),
  };
}

