/**
 * @kshema/config — custom ESLint rule: `no-banned-terms`.
 *
 * Fails the build when any user-facing string literal or JSX text contains a
 * Banned_Term (Requirement 16.1). The rule enforces Property 14 statically
 * across `apps/mobile`, `apps/admin`, and `apps/web` (including the public
 * portal), complementing the runtime property test.
 *
 * The Brand_Lexicon prohibits surveillance/medical/alarm vocabulary from every
 * user-facing string. The banned set covers the eight English terms named by
 * Requirement 16.1 — Monitoring, Surveillance, Tracking, Patient, Elderly
 * Watch, Supervision, Fall Alarm, Panic Button — plus the literal locale
 * equivalents for the five Supported_Languages (en, hi, kn, ta, te), per
 * Requirement 17.4.
 *
 * KEY-SCOPED SANCTIONED EXCEPTIONS
 * The public portal (task 24.1) renders the "Dignity Over Surveillance"
 * philosophy tenet, which deliberately *names* surveillance/tracking in order
 * to disavow them (Requirement 30.1). Those specific i18n catalog entries are
 * a bounded, documented exception. The rule supports this via the `exceptions`
 * option: a map of catalog-key → allowed-terms. When a banned term appears in
 * a string that is the value of an object property whose key matches an entry
 * in `exceptions`, only the listed terms are permitted there; every *other*
 * banned term in that same string is still reported, and the exception never
 * leaks to any other key or string. This mirrors the runtime
 * `findBannedTermForKey` guard in `apps/web/content/banned-terms.ts` so the
 * static and runtime checks agree.
 *
 * Requirements: 16.1, 16.4, 17.4, 28.18, 30.8.
 */

// Minimal structural shims for ESLint's rule contract. Declaring these locally
// (rather than importing `eslint`) keeps this package dependency-light while
// still producing a fully-shaped ESLint rule module that ESLint can consume.
export interface RuleMessageContext {
  report(descriptor: { node: unknown; messageId: string; data?: Record<string, string> }): void;
  options: unknown[];
}

/** A minimal shape of the AST nodes this rule inspects. */
export interface LiteralNode {
  value?: unknown;
  parent?: {
    type?: string;
    key?: { type?: string; name?: string; value?: unknown };
    value?: unknown;
    // For JSXAttribute parents (className="...").
    name?: { type?: string; name?: string };
  };
}

/**
 * JSX attributes whose string values are class/style tokens rather than
 * rendered copy. Tailwind ships utilities like `tracking-wide` that embed a
 * Banned_Term substring but are never shown to a user.
 */
const STYLE_ATTRIBUTES = new Set(["classname", "class", "style", "classnames", "tw", "cn"]);

export interface JSXTextNode {
  value?: unknown;
}

export interface TemplateElementNode {
  value?: { raw?: string; cooked?: string };
}

export interface RuleListener {
  Literal?: (node: LiteralNode) => void;
  JSXText?: (node: JSXTextNode) => void;
  TemplateElement?: (node: TemplateElementNode) => void;
}

export interface RuleModule {
  meta: {
    type: "problem" | "suggestion" | "layout";
    docs: { description: string; recommended: boolean };
    schema: unknown[];
    messages: Record<string, string>;
  };
  create(context: RuleMessageContext): RuleListener;
}

/**
 * English Banned_Terms enumerated by Requirement 16.1 / the Brand_Lexicon:
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
 * Locale equivalents of the core Banned_Terms for the five Supported_Languages
 * (R17.4). These are the literal translations the UI must never render. The
 * list is deliberately conservative — it targets the direct surveillance /
 * medical / alarm words so the rule does not produce false positives against
 * ordinary approved copy. Kept in sync with `apps/web/content/banned-terms.ts`.
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
 * The full default Banned_Term set: every English term plus every locale
 * equivalent, de-duplicated and lowercased. This is what the rule enforces
 * repo-wide by default.
 */
export const DEFAULT_BANNED_TERMS: readonly string[] = Array.from(
  new Set(
    Object.values(BANNED_TERMS_BY_LOCALE)
      .flat()
      .map((t) => t.toLowerCase()),
  ),
);

/** Options accepted by the rule. */
export interface NoBannedTermsOptions {
  /** Overrides {@link DEFAULT_BANNED_TERMS} when supplied. */
  readonly terms?: readonly string[];
  /**
   * Key-scoped sanctioned exceptions: for a string that is the value of an
   * object property whose key matches, the listed terms are permitted (case
   * insensitive). Every other banned term in that string is still reported.
   */
  readonly exceptions?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Returns the first Banned_Term found in `text` (case-insensitive substring
 * match), skipping any term present in `allowed`, or `undefined` when the text
 * is clean. Exported for unit testing of the detection core independent of the
 * ESLint runtime.
 */
export function findBannedTerm(
  text: string,
  terms: readonly string[] = DEFAULT_BANNED_TERMS,
  allowed: readonly string[] = [],
): string | undefined {
  if (terms.length === 0) return undefined;
  const haystack = text.toLowerCase();
  const allow = new Set(allowed.map((t) => t.toLowerCase()));
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.length > 0 && !allow.has(lower) && haystack.includes(lower)) {
      return term;
    }
  }
  return undefined;
}

/**
 * Resolves the object-property key a string Literal is the value of, if any.
 * Used to apply key-scoped sanctioned exceptions (e.g. `philosophy.heading`).
 * Returns the static key name/value, or `undefined` when the literal is not a
 * property value or the key is computed/non-static.
 */
function propertyKeyOf(node: LiteralNode): string | undefined {
  const parent = node.parent;
  if (!parent || parent.type !== "Property" || parent.value !== node) return undefined;
  const key = parent.key;
  if (!key) return undefined;
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/**
 * True when the literal is the value of a class/style JSX attribute
 * (e.g. `className="tracking-wide"`), whose tokens are not user-facing copy.
 */
function isStyleAttributeValue(node: LiteralNode): boolean {
  const parent = node.parent;
  if (!parent || parent.type !== "JSXAttribute") return false;
  const name = parent.name?.name;
  return typeof name === "string" && STYLE_ATTRIBUTES.has(name.toLowerCase());
}

/** The `no-banned-terms` ESLint rule module. */
export const noBannedTermsRule: RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Banned_Terms in user-facing strings to enforce the Kshema Brand_Lexicon (Requirement 16.1).",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          terms: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
          exceptions: {
            type: "object",
            additionalProperties: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bannedTerm:
        'Banned_Term "{{term}}" is not allowed in user-facing text. Use an approved Brand_Lexicon term instead.',
    },
  },
  create(context: RuleMessageContext): RuleListener {
    const option = (context.options[0] ?? {}) as NoBannedTermsOptions;
    const terms = option.terms ?? DEFAULT_BANNED_TERMS;
    const exceptions = option.exceptions ?? {};

    const check = (node: unknown, raw: unknown, allowed: readonly string[] = []): void => {
      if (typeof raw !== "string") return;
      const term = findBannedTerm(raw, terms, allowed);
      if (term !== undefined) {
        context.report({ node, messageId: "bannedTerm", data: { term } });
      }
    };

    return {
      Literal(node) {
        if (isStyleAttributeValue(node)) return;
        const key = propertyKeyOf(node);
        const allowed = key !== undefined ? exceptions[key] ?? [] : [];
        check(node, node.value, allowed);
      },
      JSXText(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value?.cooked ?? node.value?.raw);
      },
    };
  },
};

export default noBannedTermsRule;
