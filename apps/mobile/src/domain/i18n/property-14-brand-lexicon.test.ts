/**
 * Property 14 — Brand lexicon excludes banned terms (consolidated, repo-level).
 *
 * This is the single repo-level property test for Property 14 mandated by task
 * 25.2. Where the local `i18n.test.ts` Property 14 asserts the mobile catalog
 * against the app-local `I18N_ALL_BANNED_TERMS` guard, THIS test asserts the
 * full user-facing string catalog against the CANONICAL Brand_Lexicon owned by
 * `@kshema/config` — the same `DEFAULT_BANNED_TERMS` set that backs the
 * repo-wide `no-banned-terms` ESLint rule and the dependency-free scanner wired
 * into `apps/mobile`, `apps/admin`, and `apps/web`. Anchoring the runtime
 * property to the shared lexicon guarantees the static build gate and the
 * runtime property agree on exactly the same forbidden vocabulary, so the two
 * checks can never drift.
 *
 * Property statement (design.md, Property 14):
 *   For all user-facing catalog entries across every Supported_Language
 *   (en, hi, kn, ta, te), the rendered string SHALL contain no Banned_Term
 *   (Monitoring, Surveillance, Tracking, Patient, Elderly Watch, Supervision,
 *   Fall Alarm, Panic Button, and locale equivalents).
 *   Generator: enumerate all i18n keys × languages.
 *
 * **Validates: Requirements 16.1, 17.4**
 */
// Feature: kshema-safety-platform, Property 14
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_BANNED_TERMS, findBannedTerm } from "@kshema/config";
import {
  CATALOGS,
  MESSAGE_KEYS,
  SUPPORTED_LANGUAGES,
  translate,
  type MessageKey,
  type SupportedLanguage,
} from "./index.js";

describe("Property 14 — brand lexicon excludes banned terms (canonical @kshema/config lexicon)", () => {
  it("uses exactly the five Supported_Languages as the catalog cover", () => {
    // Guards the generator's input space: the property must range over the
    // full en/hi/kn/ta/te cover, not a subset.
    expect([...SUPPORTED_LANGUAGES]).toEqual(["en", "hi", "kn", "ta", "te"]);
    expect(Object.keys(CATALOGS).sort()).toEqual(["en", "hi", "kn", "ta", "te"]);
    expect(MESSAGE_KEYS.length).toBeGreaterThan(0);
  });

  // The core property, run over all i18n keys × languages against the canonical
  // repo-wide Banned_Term lexicon. fast-check draws (language, key) pairs; each
  // rendered catalog entry must contain no Banned_Term. min. 100 iterations.
  it("holds for all Brand_Lexicon entries across every Supported_Language", () => {
    const langArb = fc.constantFrom<SupportedLanguage>(...SUPPORTED_LANGUAGES);
    const keyArb = fc.constantFrom<MessageKey>(...MESSAGE_KEYS);
    fc.assert(
      fc.property(langArb, keyArb, (lang, key) => {
        const rendered = translate(lang, key);
        const offending = findBannedTerm(rendered, DEFAULT_BANNED_TERMS);
        expect(
          offending,
          `${lang}:${key} → "${rendered}" contains Banned_Term "${offending ?? ""}"`,
        ).toBeUndefined();
      }),
      { numRuns: 500 },
    );
  });

  // Exhaustive companion: the catalog cover is small and finite, so we also
  // check every (language, key) pair directly. This makes the guarantee total
  // rather than sampled, and pinpoints the exact offending entry on failure.
  it("no catalog entry in any locale contains a Banned_Term (exhaustive)", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of MESSAGE_KEYS) {
        const rendered = CATALOGS[lang][key];
        const offending = findBannedTerm(rendered, DEFAULT_BANNED_TERMS);
        expect(
          offending,
          `${lang}:${key} → "${rendered}" contains Banned_Term "${offending ?? ""}"`,
        ).toBeUndefined();
      }
    }
  });

  it("anchors the property to the canonical repo-wide lexicon", () => {
    // Sanity: the shared lexicon covers the eight English terms plus locale
    // equivalents, so this property is strictly at least as strong as an
    // English-only check.
    for (const term of [
      "monitoring",
      "surveillance",
      "tracking",
      "patient",
      "elderly watch",
      "supervision",
      "fall alarm",
      "panic button",
    ]) {
      expect(DEFAULT_BANNED_TERMS).toContain(term);
    }
    expect(DEFAULT_BANNED_TERMS.length).toBeGreaterThan(8);
  });
});
