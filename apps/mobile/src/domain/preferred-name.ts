/**
 * Preferred display-name prompt gate (R1.7).
 *
 * WHERE a User has not provided a preferred display name, the app must prompt
 * for one BEFORE the User joins a Circle. This module holds the pure predicate
 * and validation used by that gate; the API stores the name (R1.6).
 */

/** Max stored length for a preferred display name. */
export const PREFERRED_NAME_MAX_LENGTH = 60;

/** Normalize a candidate preferred name (trim + collapse inner whitespace). */
export function normalizePreferredName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** A normalized non-empty name within the length bound is valid. */
export function isValidPreferredName(raw: string): boolean {
  const normalized = normalizePreferredName(raw);
  return normalized.length >= 1 && normalized.length <= PREFERRED_NAME_MAX_LENGTH;
}

/**
 * R1.7 — whether the preferred-name prompt must be shown before joining a
 * Circle. Prompt when the stored name is missing or blank.
 */
export function requiresPreferredNamePrompt(
  storedName: string | null | undefined,
): boolean {
  return !storedName || normalizePreferredName(storedName).length === 0;
}
