/**
 * Multi-language i18n catalog tests (task 23.2).
 *
 * Covers R17.1 (five Supported_Languages), R17.2 (language selection
 * re-renders all text), and R17.4 / Property 14 (Brand_Lexicon meaning is
 * preserved and Banned_Terms are excluded across every locale).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CATALOGS,
  DEFAULT_LANGUAGE,
  MESSAGE_KEYS,
  SUPPORTED_LANGUAGES,
  createTranslator,
  isSupportedLanguage,
  resolveLanguage,
  translate,
  type MessageKey,
  type SupportedLanguage,
} from "./index.js";
import {
  I18N_ALL_BANNED_TERMS,
  BANNED_TERMS_EN,
  findLocaleBannedTerms,
  isLexiconClean,
} from "./banned-terms.js";

describe("Supported_Languages (R17.1)", () => {
  it("provides exactly the five Supported_Languages", () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(["en", "hi", "kn", "ta", "te"]);
    expect(Object.keys(CATALOGS).sort()).toEqual(["en", "hi", "kn", "ta", "te"]);
  });

  it("recognizes supported vs unsupported language codes", () => {
    expect(isSupportedLanguage("hi")).toBe(true);
    expect(isSupportedLanguage("fr")).toBe(false);
  });

  it("resolves region tags and falls back to the default", () => {
    expect(resolveLanguage("ta-IN")).toBe("ta");
    expect(resolveLanguage("TE")).toBe("te");
    expect(resolveLanguage("fr")).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage(null)).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
  });
});

describe("catalog coverage: every Brand_Lexicon key across all locales (R17.1)", () => {
  it("every locale supplies a non-empty value for every message key", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const catalog = CATALOGS[lang];
      for (const key of MESSAGE_KEYS) {
        const value = catalog[key];
        expect(value, `${lang}:${key}`).toBeTypeOf("string");
        expect(value.trim().length, `${lang}:${key} must be non-empty`).toBeGreaterThan(0);
      }
      // No locale carries stray keys beyond the shared contract.
      expect(Object.keys(catalog).sort()).toEqual([...MESSAGE_KEYS].sort());
    }
  });

  it("covers identical key sets across all five locales", () => {
    const reference = Object.keys(CATALOGS[DEFAULT_LANGUAGE]).sort();
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(Object.keys(CATALOGS[lang]).sort(), lang).toEqual(reference);
    }
  });
});

describe("language selection re-renders all text (R17.2)", () => {
  it("translate returns text in the selected language", () => {
    expect(translate("en", "role.anchor")).toBe("Anchor");
    expect(translate("hi", "role.anchor")).toBe("एंकर");
    expect(translate("kn", "role.anchor")).toBe("ಆಂಕರ್");
    expect(translate("ta", "role.anchor")).toBe("ஆங்கர்");
    expect(translate("te", "role.anchor")).toBe("యాంకర్");
  });

  it("setLanguage swaps the active catalog for every key", () => {
    const en = createTranslator("en");
    expect(en.language).toBe("en");
    expect(en.t("dashboard.title")).toBe("Your Circle");

    const te = en.setLanguage("te");
    expect(te.language).toBe("te");
    // Every key now renders through the new locale.
    for (const key of MESSAGE_KEYS) {
      expect(te.t(key)).toBe(CATALOGS.te[key]);
    }
    // The original translator is unchanged (pure swap).
    expect(en.t("dashboard.title")).toBe("Your Circle");
  });

  it("default translator uses the default language", () => {
    expect(createTranslator().language).toBe(DEFAULT_LANGUAGE);
  });
});

describe("banned-term guard helpers", () => {
  it("detects a banned term regardless of case", () => {
    expect(isLexiconClean("Live monitoring feed")).toBe(false);
    expect(findLocaleBannedTerms("SURVEILLANCE report")).toContain("Surveillance");
  });

  it("passes clean Brand_Lexicon text", () => {
    expect(isLexiconClean("Your Circle is all well")).toBe(true);
  });
});

/**
 * Property 14: Brand lexicon excludes banned terms.
 * For all catalog entries across every Supported_Language, the rendered string
 * contains no Banned_Term (English terms and locale equivalents).
 *
 * **Validates: Requirements 16.1, 17.4**
 */
describe("Property 14 — no Banned_Term in any locale (R16.1, R17.4)", () => {
  it("no catalog entry in any locale contains a Banned_Term (enumerated)", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of MESSAGE_KEYS) {
        const value = CATALOGS[lang][key];
        const hits = findLocaleBannedTerms(value);
        expect(hits, `${lang}:${key} → "${value}" contains ${hits.join(", ")}`).toEqual([]);
      }
    }
  });

  it("holds across all i18n keys × languages (property)", () => {
    const langArb = fc.constantFrom<SupportedLanguage>(...SUPPORTED_LANGUAGES);
    const keyArb = fc.constantFrom<MessageKey>(...MESSAGE_KEYS);
    fc.assert(
      fc.property(langArb, keyArb, (lang, key) => {
        const rendered = translate(lang, key);
        expect(isLexiconClean(rendered)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("the English Banned_Term list matches the spec (R16.1)", () => {
    expect([...BANNED_TERMS_EN]).toEqual([
      "Monitoring",
      "Surveillance",
      "Tracking",
      "Patient",
      "Elderly Watch",
      "Supervision",
      "Fall Alarm",
      "Panic Button",
    ]);
    // The global scan set includes locale equivalents beyond English.
    expect(I18N_ALL_BANNED_TERMS.length).toBeGreaterThan(BANNED_TERMS_EN.length);
  });
});
