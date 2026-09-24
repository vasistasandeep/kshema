/**
 * Sanctuary Mode suspension gate (R34.1, R34.2, R34.4, R34.5).
 *
 * A `SanctuarySchedule` is a user-scheduled pause of Sentinel_Worker evaluation
 * for a documented event (travel, medical procedure, retreat) with an automatic
 * resumption time (design "Sanctuary Mode gate (R34)"). Before opening any
 * Safety_Incident for an Anchor, the worker consults the active schedule:
 *
 *   shouldEvaluate(anchor, now):
 *     s = activeSanctuary(anchor)      # isActive && startsAt <= now < resumesAt
 *     if s: return SUSPENDED           # skip routine eval, WhatsApp pings, ALL stages (R34.2)
 *     return EVALUATE
 *
 * Everything here is **pure**: {@link isSanctuaryActive} is a deterministic
 * predicate over `(schedules, now)` with no clock reads, no I/O, and no mutation
 * of its inputs. Auto-resume (R34.4) is therefore *implicit* and *idempotent* —
 * once `now >= resumesAt` the predicate simply returns `false` with NO manual
 * reactivation and NO state write. Because the gate is time-based rather than
 * event-based, a missed worker tick (downtime) never leaves evaluation
 * suspended past `resumesAt`: the very next consult resumes automatically
 * (design edge case "Sanctuary auto-resume safety (R34.4)").
 *
 * The gate ONLY decides whether to suppress incident opening. It never touches
 * Vitality_Streak state, so the Circle Vitality_Streak is preserved across the
 * window by construction (R34.5) — see {@link SANCTUARY_STREAK_PRESERVED}.
 */

/** Maximum Sanctuary window length: 14 days, in milliseconds (R34.1). */
export const SANCTUARY_MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Structural guarantee marker (R34.5): the Sanctuary gate performs no streak
 * mutation. It exposes only the read-only {@link isSanctuaryActive} predicate
 * and the {@link SanctuaryGate.shouldSuppressIncident} guard, neither of which
 * reads or writes Vitality_Streak state. Preservation is therefore structural,
 * not behavioral — there is simply no code path from the gate to the streak.
 */
export const SANCTUARY_STREAK_PRESERVED = true as const;

/**
 * Minimal shape of a `SanctuarySchedule` the gate needs. Deliberately narrower
 * than the Prisma model (which also carries `id`, `reason`, `createdAt`, the
 * `user` relation) so the gate stays decoupled from the DB row shape and fully
 * unit-testable. Dates are accepted as `Date` or epoch-millis for convenience.
 */
export interface SanctuaryWindow {
  /** The Anchor whose evaluation is suspended. */
  userId: string;
  /** Window start. */
  startsAt: Date | number;
  /** Automatic resumption time; `<= startsAt + 14d` (R34.1). */
  resumesAt: Date | number;
  /** Whether the schedule is active (may be flipped off by an early manual end). */
  isActive: boolean;
}

/** Coerce a `Date | number` into epoch-millis. */
function toMillis(value: Date | number): number {
  return typeof value === "number" ? value : value.getTime();
}

/**
 * Clamp a Sanctuary window's `resumesAt` so the effective window never exceeds
 * `startsAt + 14d` (R34.1). The API route validates this on create, but the
 * gate treats an over-long window **defensively**: an over-long `resumesAt` is
 * clamped down to `startsAt + 14d` rather than trusted, so a bad row cannot
 * suspend evaluation for longer than the policy maximum.
 *
 * Returns the effective (clamped) `resumesAt` in epoch-millis.
 */
export function clampResumesAt(startsAt: Date | number, resumesAt: Date | number): number {
  const start = toMillis(startsAt);
  const resume = toMillis(resumesAt);
  const maxResume = start + SANCTUARY_MAX_WINDOW_MS;
  return resume > maxResume ? maxResume : resume;
}

/**
 * Validate that a window's `resumesAt` falls within the 14-day maximum from
 * `startsAt` (R34.1). Returns `true` iff `startsAt < resumesAt <= startsAt + 14d`.
 * A zero/negative-length window (`resumesAt <= startsAt`) is not valid.
 */
export function isWindowWithin14Days(
  startsAt: Date | number,
  resumesAt: Date | number,
): boolean {
  const start = toMillis(startsAt);
  const resume = toMillis(resumesAt);
  return resume > start && resume <= start + SANCTUARY_MAX_WINDOW_MS;
}

/**
 * Pure predicate: is Sanctuary Mode active at `now` for the given schedules?
 *
 * Returns `true` iff **some** schedule is `isActive` and its window contains
 * `now` (`startsAt <= now < resumesAt`), with `resumesAt` defensively clamped to
 * `startsAt + 14d` (R34.1). `resumesAt` is exclusive so the instant of
 * resumption is already "evaluate" — this is the auto-resume boundary (R34.4).
 *
 * No clock is read (the caller passes `now`), no schedule is mutated, and no
 * "resume" state write happens: once `now >= resumesAt` the window simply stops
 * matching. That makes auto-resume idempotent and downtime-safe (R34.4).
 */
export function isSanctuaryActive(
  schedules: readonly SanctuaryWindow[],
  now: Date | number,
): boolean {
  const nowMs = toMillis(now);
  for (const s of schedules) {
    if (!s.isActive) continue;
    const start = toMillis(s.startsAt);
    if (nowMs < start) continue;
    const effectiveResume = clampResumesAt(s.startsAt, s.resumesAt);
    if (nowMs < effectiveResume) return true;
  }
  return false;
}

/**
 * Injectable seam that fetches the (candidate) active Sanctuary windows for one
 * Anchor. Kept narrow so tests pass a pure array and production wiring passes a
 * DB-backed closure (e.g. Prisma `sanctuarySchedule.findMany({ where: { userId,
 * isActive: true } })`). It may over-return (e.g. include not-yet-clamped or
 * past-resume rows); {@link isSanctuaryActive} filters by time authoritatively.
 */
export type FetchActiveSanctuary = (
  anchorId: string,
  now: Date | number,
) => Promise<readonly SanctuaryWindow[]> | readonly SanctuaryWindow[];

/**
 * The guard the incident-opening path consults BEFORE opening any incident.
 * When Sanctuary is active for the Anchor it suppresses routine evaluation,
 * WhatsApp pings, and ALL escalation stages — i.e. no incident opens (R34.2).
 */
export interface SanctuaryGate {
  /**
   * Resolve whether an incident-open for `anchorId` at `now` must be suppressed.
   * `true` ⇒ Sanctuary is active ⇒ do NOT open an incident (R34.2). `false` ⇒
   * proceed with the normal decision. Never throws for a missing schedule; an
   * empty schedule set resolves to `false` (evaluate normally).
   */
  shouldSuppressIncident(
    anchorId: string,
    now: Date | number,
  ): Promise<boolean>;
}

/**
 * Build a {@link SanctuaryGate} over an injectable schedule-fetch seam.
 *
 * The gate is stateless: every consult re-fetches the Anchor's windows and
 * re-evaluates {@link isSanctuaryActive} against `now`, so resumption is purely
 * a function of the clock (R34.4). It never writes back a "resumed" flag and
 * never touches Vitality_Streak (R34.5).
 */
export function createSanctuaryGate(fetch: FetchActiveSanctuary): SanctuaryGate {
  return {
    async shouldSuppressIncident(anchorId, now) {
      const schedules = await fetch(anchorId, now);
      return isSanctuaryActive(schedules, now);
    },
  };
}

/**
 * A no-op gate that never suppresses. Useful as a safe default for wiring that
 * has not yet been given a real schedule source, and as an explicit "Sanctuary
 * disabled" seam in tests.
 */
export function createNoopSanctuaryGate(): SanctuaryGate {
  return {
    async shouldSuppressIncident() {
      return false;
    },
  };
}
