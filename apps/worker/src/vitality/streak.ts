/**
 * Vitality_Streak logic (R22.1-R22.6; task 14.1).
 *
 * The `vitality` queue owns the family-engagement side of a confirmed morning
 * Routine_Rhythm. This module holds the PURE streak state transitions; every
 * transition is a pure function `(state, input) -> state` so the processor
 * wiring (`processor.ts`) and the unit tests stay hermetic. No side effects, no
 * Prisma, no queues here.
 *
 * CRITICAL INVARIANT (R22.6): nothing in this module — and nothing in the
 * whole `vitality/` folder — may open a Safety_Incident or trigger escalation.
 * A streak reset or a Streak_Freeze is a warm, cooperative event, structurally
 * separate from the rhythm/escalation paths. The functions here return plain
 * data describing the next streak state and never reach for an `openIncident`
 * seam. See `pulse.ts` / `processor.ts`: neither imports the escalation queue.
 *
 * Requirement mapping:
 *   - R22.1 Vitality_Streak counts consecutive confirmed morning days per Circle.
 *   - R22.2 A confirmed morning Routine_Rhythm increments the streak by one.
 *   - R22.4 A delayed check or a no-crisis resolution PRESERVES the active streak.
 *   - R22.5 "Traveling" / battery-maintenance applies a Streak_Freeze for up to
 *           3 consecutive days; a frozen day neither increments nor breaks the
 *           streak.
 *   - R22.6 A streak reset OR freeze SHALL NEVER trigger a Safety_Incident.
 */

/**
 * The persisted Vitality_Streak state for a Circle. Mirrors the `VitalityStreak`
 * Prisma model's mutable fields (`count`, `lastConfirmedDay`, `freezeUntil`) but
 * expressed as plain data so the pure transitions never touch the DB.
 */
export interface StreakState {
  /** Consecutive confirmed-morning day count (R22.1). */
  count: number;
  /**
   * The last calendar day (yyyy-mm-dd in the Anchor timezone) a confirmed
   * morning was credited. `null` before the first confirmation. Used to make
   * {@link incrementStreak} idempotent per day.
   */
  lastConfirmedDay: string | null;
  /**
   * Streak_Freeze horizon as a yyyy-mm-dd day (Anchor tz), inclusive. While the
   * service day is `<= freezeUntil` the streak is frozen: it neither increments
   * nor breaks (R22.5). `null` when no freeze is active.
   */
  freezeUntil: string | null;
}

/** The maximum Streak_Freeze span, in consecutive days (R22.5). */
export const MAX_STREAK_FREEZE_DAYS = 3;

/** A fresh, empty streak (count 0, never confirmed, no freeze). */
export function emptyStreakState(): StreakState {
  return { count: 0, lastConfirmedDay: null, freezeUntil: null };
}

/**
 * Render an epoch-millis instant as a `yyyy-mm-dd` calendar day in the given
 * IANA timezone. This is the canonical "service day" key used for streak
 * idempotency and for the Streak_Freeze horizon, and it matches the
 * `VitalityStreak.lastConfirmedDay` column contract ("yyyy-mm-dd in anchor tz").
 *
 * Uses `Intl.DateTimeFormat` with `en-CA` (which formats as `yyyy-mm-dd`) so the
 * result is locale-stable and DST-correct for the Anchor's zone.
 */
export function serviceDayInTimezone(atMillis: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA yields "YYYY-MM-DD"; normalize any locale separator just in case.
  return fmt.format(new Date(atMillis)).replaceAll("/", "-");
}

/**
 * Compare two `yyyy-mm-dd` day strings lexicographically. Because the format is
 * zero-padded and fixed-width, lexicographic order equals chronological order.
 * Returns a negative number if `a` is before `b`, 0 if equal, positive if after.
 */
export function compareDays(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when the service `day` falls within an active Streak_Freeze (R22.5). */
export function isFrozen(state: StreakState, day: string): boolean {
  return state.freezeUntil !== null && compareDays(day, state.freezeUntil) <= 0;
}

/**
 * Increment the Vitality_Streak for a confirmed morning Routine_Rhythm (R22.2),
 * idempotent per calendar day.
 *
 * Rules:
 *   - If the streak was already credited for `day` (`lastConfirmedDay === day`),
 *     this is a strict no-op — a second confirming signal on the same morning
 *     does not double-count (returns the state unchanged, `incremented=false`).
 *   - Otherwise the count increments by one and `lastConfirmedDay` advances to
 *     `day`.
 *
 * Note: a confirmed morning is credited even while a Streak_Freeze is active —
 * confirming your routine on a travel day is still a real confirmation. The
 * freeze only matters for days WITHOUT a confirmation (see {@link resolveDay}).
 * This function NEVER opens an incident (R22.6).
 */
export function incrementStreak(
  state: StreakState,
  day: string,
): { state: StreakState; incremented: boolean } {
  if (state.lastConfirmedDay === day) {
    return { state, incremented: false };
  }
  return {
    state: { ...state, count: state.count + 1, lastConfirmedDay: day },
    incremented: true,
  };
}

/**
 * Preserve the active Vitality_Streak across a delayed check or a no-crisis
 * resolution (R22.4). Preservation is deliberately a no-op on the streak state:
 * the streak is neither incremented nor reset. Modeled as an explicit function
 * (rather than "do nothing") so the intent is legible at the call site and so
 * the processor can log/record the preservation without risking a reset.
 *
 * NEVER opens an incident (R22.6).
 */
export function preserveStreak(state: StreakState): StreakState {
  return state;
}

/**
 * Apply a Streak_Freeze of up to {@link MAX_STREAK_FREEZE_DAYS} consecutive
 * days starting at `startDay` (inclusive), for a "Traveling" status or detected
 * battery maintenance (R22.5).
 *
 * `requestedDays` is clamped to `[1, MAX_STREAK_FREEZE_DAYS]`. The resulting
 * `freezeUntil` is the last frozen day: `startDay + (clampedDays - 1)`. The
 * count is untouched — a freeze preserves, it never increments or resets.
 *
 * NEVER opens an incident (R22.6).
 */
export function applyStreakFreeze(
  state: StreakState,
  startDay: string,
  requestedDays: number,
): StreakState {
  const clamped = Math.max(1, Math.min(MAX_STREAK_FREEZE_DAYS, Math.trunc(requestedDays)));
  // The freeze covers `clamped` consecutive days; the last one is the horizon.
  const freezeUntil = addDays(startDay, clamped - 1);
  return { ...state, freezeUntil };
}

/**
 * Resolve what happens to the streak on a day with NO confirmed morning
 * routine — the only place a streak can break. This is the cooperative reset
 * path (R22.3): a plain reset of the count with no shaming, and crucially with
 * NO incident/escalation (R22.6).
 *
 *   - If `day` is within an active Streak_Freeze, the streak is preserved
 *     unchanged (a frozen day neither increments nor breaks — R22.5).
 *   - Otherwise the streak resets its count to 0 (R22.3). `lastConfirmedDay` is
 *     left as-is (it records the genuine last confirmation) and any freeze that
 *     has now elapsed is cleared.
 *
 * This function exists so callers have an explicit, incident-free way to handle
 * a missed day. It is intentionally NOT wired to any escalation path.
 */
export function resolveUnconfirmedDay(
  state: StreakState,
  day: string,
): { state: StreakState; reset: boolean; frozen: boolean } {
  if (isFrozen(state, day)) {
    return { state, reset: false, frozen: true };
  }
  // Freeze (if any) has elapsed by this unconfirmed day; clear it and reset.
  const cleared = state.freezeUntil !== null && compareDays(day, state.freezeUntil) > 0;
  return {
    state: { ...state, count: 0, freezeUntil: cleared ? null : state.freezeUntil },
    reset: true,
    frozen: false,
  };
}

/**
 * Add `n` whole days to a `yyyy-mm-dd` day string, returning a `yyyy-mm-dd`
 * string. Computed in UTC so it is purely calendar arithmetic independent of
 * any timezone/DST (the input day is already the Anchor-tz calendar day).
 */
export function addDays(day: string, n: number): string {
  const parts = day.split("-");
  const y = Number.parseInt(parts[0] ?? "", 10);
  const m = Number.parseInt(parts[1] ?? "", 10);
  const d = Number.parseInt(parts[2] ?? "", 10);
  const base = Date.UTC(y, m - 1, d);
  const shifted = new Date(base + n * 24 * 60 * 60 * 1000);
  const yy = shifted.getUTCFullYear().toString().padStart(4, "0");
  const mm = (shifted.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = shifted.getUTCDate().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
