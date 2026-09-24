import { describe, it, expect } from "vitest";
import {
  ALL_BANNED_TERMS,
  BANNED_TERMS_EN,
  SANCTIONED_TERM_EXCEPTIONS,
  containsBannedTerm,
  findBannedTerm,
  findBannedTermForKey,
} from "./banned-terms";
import { CATALOGS } from "./catalog";
import { SUPPORTED_LOCALES } from "./locales";

// Feature: kshema-safety-platform, Property 14
describe("Banned_Term exclusion across all public-portal catalogs (R30.8)", () => {
  it("no rendered catalog string contains any Banned_Term, in any Supported_Language", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = CATALOGS[locale];
      for (const [key, value] of Object.entries(catalog)) {
        // Catalog-aware: the philosophy tenet may name surveillance/tracking to
        // reject them (R30.1); every other term is still forbidden.
        const hit = findBannedTermForKey(key, value, locale);
        expect(
          hit,
          `locale=${locale} key=${key} contains Banned_Term "${hit}" in: ${value}`,
        ).toBeUndefined();
      }
    }
  });

  it("only the philosophy tenet keys are granted a Banned_Term exception (R30.1)", () => {
    expect(Object.keys(SANCTIONED_TERM_EXCEPTIONS).sort()).toEqual([
      "philosophy.heading",
      "philosophy.lede",
    ]);
    // The exception is scoped: the same banned term elsewhere is still flagged.
    expect(
      findBannedTermForKey("legal.terms.body", "we run surveillance", "en"),
    ).toBe("surveillance");
    // A non-sanctioned banned term inside a sanctioned key is still caught.
    expect(
      findBannedTermForKey("philosophy.heading", "panic button and surveillance", "en"),
    ).toBe("panic button");
  });

  it("detects English Banned_Terms case-insensitively (guard sanity)", () => {
    expect(containsBannedTerm("We offer 24/7 Monitoring")).toBe(true);
    expect(containsBannedTerm("panic BUTTON on the home screen")).toBe(true);
    expect(containsBannedTerm("A calm morning check-in")).toBe(false);
  });

  it("flags any string that embeds a banned term as a substring", () => {
    const affixes = ["", "a", "our ", " service", "-24/7", "🙂", "The "];
    for (const term of BANNED_TERMS_EN) {
      for (const pre of affixes) {
        for (const post of affixes) {
          expect(
            containsBannedTerm(`${pre}${term}${post}`),
            `expected banned: "${pre}${term}${post}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("exposes a de-duplicated multi-locale term set", () => {
    expect(ALL_BANNED_TERMS.length).toBe(new Set(ALL_BANNED_TERMS).size);
    expect(ALL_BANNED_TERMS).toContain("surveillance");
  });
});
