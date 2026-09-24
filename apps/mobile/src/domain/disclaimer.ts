/**
 * Safety_Disclaimer content + acceptance gate (R26).
 *
 * R26.1 — the disclaimer must state that Kshema is an ambient routine-assurance
 *         and software-notification utility; that it is NOT a licensed medical
 *         device, security company, or official emergency service; and that it
 *         depends on cellular networks, push delivery, and third-party gateways.
 * R26.2 — Ambient_Shield may not activate for an Anchor until the disclaimer and
 *         terms are explicitly accepted.
 * R26.3 — acceptance is recorded with a timestamp and version (posted to the API
 *         by the caller; this module produces the record).
 * R26.4 — the text uses the Brand_Lexicon and excludes every Banned_Term.
 */

/** Current Safety_Disclaimer version. Bump when the copy materially changes. */
export const DISCLAIMER_VERSION = "2024-06-01" as const;

/**
 * The mandatory disclosure points (R26.1). Kept as discrete lines so the UI can
 * render them as a checklist and tests can assert coverage + lexicon
 * compliance. Written entirely in the Brand_Lexicon (R26.4).
 */
export const DISCLAIMER_STATEMENTS: readonly string[] = [
  "Kshema is an ambient routine-assurance and software-notification utility that helps your Circle share peace of mind.",
  "Kshema is not a licensed medical device and does not provide medical advice or diagnosis.",
  "Kshema is not a security company and is not an official emergency service.",
  "Kshema depends on cellular networks, push notification delivery, and third-party messaging and voice gateways, which can be delayed or unavailable.",
];

/**
 * Banned_Terms (R16 Brand_Lexicon) that must never appear in user-facing copy.
 * Mirrors the glossary's Banned_Term list; used to assert R26.4 in tests.
 */
export const BANNED_TERMS: readonly string[] = [
  "monitoring",
  "surveillance",
  "tracking",
  "patient",
  "elderly watch",
  "supervision",
  "fall alarm",
  "panic button",
];

/** A recorded acceptance of the Safety_Disclaimer (R26.3). */
export interface DisclaimerAcceptance {
  /** Disclaimer copy version the user accepted. */
  readonly version: string;
  /** ISO-8601 acceptance timestamp. */
  readonly acceptedAt: string;
}

/**
 * Build a {@link DisclaimerAcceptance} record for the current disclaimer version
 * (R26.3). `now` is injectable for deterministic tests.
 */
export function recordDisclaimerAcceptance(
  now: Date = new Date(),
): DisclaimerAcceptance {
  return { version: DISCLAIMER_VERSION, acceptedAt: now.toISOString() };
}

/**
 * R26.2 — whether Ambient_Shield may activate. Activation is permitted only when
 * a recorded acceptance exists AND it matches the current disclaimer version
 * (a stale acceptance to an older version does not unlock a newer disclaimer).
 */
export function canActivateAmbientShield(
  acceptance: DisclaimerAcceptance | null | undefined,
): boolean {
  return !!acceptance && acceptance.version === DISCLAIMER_VERSION;
}

/**
 * R26.4 — assert a piece of user-facing copy contains no Banned_Term. Returns
 * the list of any banned terms found (empty = compliant). Case-insensitive.
 */
export function findBannedTerms(text: string): string[] {
  const haystack = text.toLowerCase();
  return BANNED_TERMS.filter((term) => haystack.includes(term));
}
