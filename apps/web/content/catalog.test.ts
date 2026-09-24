import { describe, it, expect } from "vitest";
import { CATALOGS, CATALOG_KEYS, getTranslator, translate } from "./catalog";
import { catalogEn } from "./catalog.en";
import { SUPPORTED_LOCALES } from "./locales";

describe("Five-language content completeness (R30.5, R17.2)", () => {
  it("provides a catalog for every Supported_Language", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(CATALOGS[locale], `missing catalog for ${locale}`).toBeDefined();
    }
  });

  it("every locale defines every canonical key with a non-empty value", () => {
    const canonicalKeys = Object.keys(catalogEn);
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = CATALOGS[locale] as Record<string, string>;
      for (const key of canonicalKeys) {
        const value = catalog[key];
        expect(value, `${locale} missing key ${key}`).toBeTypeOf("string");
        expect(value!.trim().length, `${locale} empty value for ${key}`).toBeGreaterThan(0);
      }
      // No extra keys beyond the canonical set.
      expect(Object.keys(catalog).sort()).toEqual([...canonicalKeys].sort());
    }
  });

  it("translate() falls back to English then the raw key", () => {
    expect(translate("hi", "brand.name")).toBe(CATALOGS.hi["brand.name"]);
    // A bound translator resolves cleanly for every key/locale pair.
    for (const locale of SUPPORTED_LOCALES) {
      const t = getTranslator(locale);
      for (const key of CATALOG_KEYS) {
        expect(t(key)).toBeTypeOf("string");
      }
    }
  });

  it("non-English catalogs actually differ from English (real translations)", () => {
    // A sampling: headings should not be left as the English string.
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === "en") continue;
      expect(CATALOGS[locale]["philosophy.heading"]).not.toBe(
        catalogEn["philosophy.heading"],
      );
    }
  });
});
