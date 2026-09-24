import { describe, expect, it, vi } from "vitest";
import {
  BANNED_TERMS_BY_LOCALE,
  BANNED_TERMS_EN,
  DEFAULT_BANNED_TERMS,
  findBannedTerm,
  noBannedTermsRule,
} from "./no-banned-terms";

describe("no-banned-terms rule metadata", () => {
  it("is a problem-type rule with an options schema and messages", () => {
    expect(noBannedTermsRule.meta.type).toBe("problem");
    expect(noBannedTermsRule.meta.schema).toHaveLength(1);
    expect(noBannedTermsRule.meta.messages).toHaveProperty("bannedTerm");
  });

  it("declares a `terms` and `exceptions` options schema", () => {
    const schema = noBannedTermsRule.meta.schema[0] as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("terms");
    expect(schema.properties).toHaveProperty("exceptions");
  });
});

describe("DEFAULT_BANNED_TERMS lexicon (R16.1, R17.4)", () => {
  it("covers all eight English Banned_Terms", () => {
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
      expect(BANNED_TERMS_EN).toContain(term);
      expect(DEFAULT_BANNED_TERMS).toContain(term);
    }
  });

  it("includes locale equivalents for hi/kn/ta/te", () => {
    for (const locale of ["hi", "kn", "ta", "te"]) {
      const localeTerms = BANNED_TERMS_BY_LOCALE[locale]!;
      expect(localeTerms.length).toBeGreaterThan(0);
      for (const term of localeTerms) {
        expect(DEFAULT_BANNED_TERMS).toContain(term.toLowerCase());
      }
    }
  });

  it("is de-duplicated and lowercased", () => {
    expect(DEFAULT_BANNED_TERMS.length).toBe(new Set(DEFAULT_BANNED_TERMS).size);
    expect(DEFAULT_BANNED_TERMS.every((t) => t === t.toLowerCase())).toBe(true);
  });
});

describe("findBannedTerm detection core", () => {
  it("detects a default banned term case-insensitively", () => {
    expect(findBannedTerm("We provide continuous MONITORING")).toBe("monitoring");
    expect(findBannedTerm("Live Tracking of your family")).toBe("tracking");
  });

  it("returns undefined for clean approved copy", () => {
    expect(findBannedTerm("A calm morning check-in with your Anchor")).toBeUndefined();
    expect(findBannedTerm("All Well — gentle ambient care")).toBeUndefined();
  });

  it("detects a locale-equivalent banned term", () => {
    expect(findBannedTerm("निगरानी सेवा")).toBe("निगरानी");
    expect(findBannedTerm("கண்காணிப்பு")).toBe("கண்காணிப்பு");
  });

  it("honors an allowed list (scoped exception) but still flags other terms", () => {
    expect(findBannedTerm("not surveillance", DEFAULT_BANNED_TERMS, ["surveillance"])).toBeUndefined();
    // a different banned term in the same string is still caught
    expect(
      findBannedTerm("not surveillance but tracking", DEFAULT_BANNED_TERMS, ["surveillance"]),
    ).toBe("tracking");
  });

  it("returns undefined when the term list is empty", () => {
    expect(findBannedTerm("Surveillance and Monitoring", [])).toBeUndefined();
  });

  it("ignores empty terms in the list", () => {
    expect(findBannedTerm("anything", [""])).toBeUndefined();
  });
});

describe("no-banned-terms rule.create", () => {
  const makeContext = (options?: unknown) => {
    const report = vi.fn();
    const context = { report, options: options ? [options] : [] };
    return { context, report };
  };

  it("reports a banned term found in a string Literal under the default lexicon", () => {
    const { context, report } = makeContext();
    const listener = noBannedTermsRule.create(context);
    listener.Literal?.({ value: "Press the Panic Button" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "bannedTerm", data: { term: "panic button" } }),
    );
  });

  it("reports banned terms in JSX text and template elements", () => {
    const { context, report } = makeContext();
    const listener = noBannedTermsRule.create(context);
    listener.JSXText?.({ value: "Live Tracking enabled" });
    listener.TemplateElement?.({ value: { cooked: "24/7 Monitoring" } });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("does not report clean approved copy", () => {
    const { context, report } = makeContext();
    const listener = noBannedTermsRule.create(context);
    listener.Literal?.({ value: "All Well" });
    listener.JSXText?.({ value: "Your Circle is at peace" });
    expect(report).not.toHaveBeenCalled();
  });

  it("ignores non-string literal values", () => {
    const { context, report } = makeContext();
    const listener = noBannedTermsRule.create(context);
    listener.Literal?.({ value: 42 });
    listener.Literal?.({ value: true });
    expect(report).not.toHaveBeenCalled();
  });

  it("honors a key-scoped sanctioned exception on the philosophy tenet", () => {
    const { context, report } = makeContext({
      exceptions: { "philosophy.heading": ["surveillance"] },
    });
    const listener = noBannedTermsRule.create(context);
    // A Literal that is the value of a Property keyed "philosophy.heading".
    const node = {
      value: "Dignity Over Surveillance",
      parent: {
        type: "Property",
        key: { type: "Literal", value: "philosophy.heading" },
        value: undefined as unknown,
      },
    };
    node.parent.value = node;
    listener.Literal?.(node);
    expect(report).not.toHaveBeenCalled();
  });

  it("still flags a non-sanctioned term inside a sanctioned key", () => {
    const { context, report } = makeContext({
      exceptions: { "philosophy.heading": ["surveillance"] },
    });
    const listener = noBannedTermsRule.create(context);
    const node = {
      value: "surveillance and panic button",
      parent: {
        type: "Property",
        key: { type: "Identifier", name: "philosophy" },
        value: undefined as unknown,
      },
    };
    node.parent.value = node;
    // Identifier key "philosophy" is not in the exceptions map, so nothing is allowed here.
    listener.Literal?.(node);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ data: { term: "surveillance" } }),
    );
  });

  it("does not leak the exception to a different key", () => {
    const { context, report } = makeContext({
      exceptions: { "philosophy.heading": ["surveillance"] },
    });
    const listener = noBannedTermsRule.create(context);
    const node = {
      value: "we run surveillance",
      parent: {
        type: "Property",
        key: { type: "Literal", value: "legal.terms.body" },
        value: undefined as unknown,
      },
    };
    node.parent.value = node;
    listener.Literal?.(node);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("does not flag Tailwind class tokens in a className JSX attribute", () => {
    const { context, report } = makeContext();
    const listener = noBannedTermsRule.create(context);
    const node = {
      value: "text-sm uppercase tracking-wide",
      parent: { type: "JSXAttribute", name: { type: "JSXIdentifier", name: "className" } },
    };
    listener.Literal?.(node);
    expect(report).not.toHaveBeenCalled();
  });

  it("still flags a banned term in a non-style JSX attribute", () => {
    const { context, report } = makeContext();
    const listener = noBannedTermsRule.create(context);
    const node = {
      value: "Live Tracking",
      parent: { type: "JSXAttribute", name: { type: "JSXIdentifier", name: "aria-label" } },
    };
    listener.Literal?.(node);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("supports a custom `terms` override", () => {
    const { context, report } = makeContext({ terms: ["snooping"] });
    const listener = noBannedTermsRule.create(context);
    listener.Literal?.({ value: "no more snooping" });
    // default terms are replaced, so 'monitoring' would now be allowed
    listener.Literal?.({ value: "monitoring" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ data: { term: "snooping" } }),
    );
  });
});
