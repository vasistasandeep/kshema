/**
 * i18n catalog registry + translator factory for the public portal.
 *
 * Every Supported_Language (en, hi, kn, ta, te) provides a complete catalog
 * keyed by the canonical {@link CatalogKey} set (R30.5). A missing key fails
 * typecheck because each non-English catalog is typed `Catalog`. The `t()`
 * helper resolves a key for a locale and falls back to English then to the raw
 * key, so a page can never render `undefined`.
 *
 * Requirements: 30.5, 17.1, 17.2.
 */
import type { Locale } from "./locales";
import { DEFAULT_LOCALE } from "./locales";
import { catalogEn, type Catalog, type CatalogKey } from "./catalog.en";
import { catalogHi } from "./catalog.hi";
import { catalogKn } from "./catalog.kn";
import { catalogTa } from "./catalog.ta";
import { catalogTe } from "./catalog.te";

export type { Catalog, CatalogKey } from "./catalog.en";

/** All five catalogs, indexed by Supported_Language. */
export const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: catalogEn,
  hi: catalogHi,
  kn: catalogKn,
  ta: catalogTa,
  te: catalogTe,
};

/** The canonical, ordered list of every i18n key. */
export const CATALOG_KEYS = Object.keys(catalogEn) as CatalogKey[];

/** A bound translator function for one locale. */
export type Translator = (key: CatalogKey) => string;

/**
 * Resolves a single catalog key for a locale, falling back to English and then
 * the raw key. Never returns `undefined`.
 */
export function translate(locale: Locale, key: CatalogKey): string {
  return CATALOGS[locale]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key] ?? key;
}

/** Builds a translator bound to a locale (convenient for page components). */
export function getTranslator(locale: Locale): Translator {
  const catalog = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
  return (key) => catalog[key] ?? CATALOGS[DEFAULT_LOCALE][key] ?? key;
}
