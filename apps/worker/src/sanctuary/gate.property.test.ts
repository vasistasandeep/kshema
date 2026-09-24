// Feature: kshema-safety-platform, Property 24: Sanctuary Mode suppression,
// auto-resume, and streak preservation. For all Anchors with a
// SanctuarySchedule and any timeline of ticks, while `startsAt <= now <
// resumesAt` and the schedule is active no Safety_Incident SHALL open (and no
// WhatsApp ping or escalation stage SHALL fire); at exactly `now >= resumesAt`
// standard Sentinel_Policy evaluation SHALL resume without manual
// reactivation; and the Circle Vitality_Streak SHALL be identical before and
// after the Sanctuary window.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SANCTUARY_MAX_WINDOW_MS,
  SANCTUARY_STREAK_PRESERVED,
  clampResumesAt,
  isSanctuaryActive,
  type SanctuaryWindow,
} from "./gate.js";

/**
 * Validates: Requirements 34.2, 34.4, 34.5
 *
 * Property 24 asserts, across arbitrary schedule sets and arbitrary `now`
 * instants, that the pure Sanctuary gate:
 *   (a) R34.2 — suppresses (returns `true`) iff SOME active schedule has
 *       `startsAt <= now < clampedResumesAt`;
 *   (b) R34.4 — auto-resumes: for `now >= resumesAt` it returns `false`, and it
 *       never mutates the input schedules (idempotent, no state write);
 *   (c) an over-long window (`resumesAt > startsAt + 14d`) never suppresses past
 *       `startsAt + 14d` (defensive clamp);
 *   (d) R34.5 — streak preservation is STRUCTURAL: the gate exposes/uses no
 *       streak state — `isSanctuaryActive` takes only `(schedules, now)`.
 *
 * The generators intentionally straddle every boundary (before start, at start,
 * mid-window, at resume, after resume) and include inactive schedules,
 * zero/negative-length windows, and over-long windows so all branches are hit.
 */
describe("isSanctuaryActive — Property 24 (R34.2/R34.4/R34.5)", () => {
  // A wide but finite instant domain centred on a real epoch so date math is
  // meaningful and never NaN/Infinity. ~+/- 100 days around the base.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BASE = Date.UTC(2025, 0, 1, 0, 0, 0);
  const SPAN = 100 * DAY_MS;

  const instant = fc.integer({ min: BASE - SPAN, max: BASE + SPAN });

  // A window generator that produces starts across the domain and resumesAt
  // offsets that straddle the 14-day cap (including zero/negative-length and
  // wildly over-long windows), plus an arbitrary active flag.
  const windowArb: fc.Arbitrary<SanctuaryWindow> = fc.record({
    userId: fc.constantFrom("anchor-1", "anchor-2", "anchor-3"),
    startsAt: instant,
    // Duration relative to startsAt: from slightly negative (invalid) up to
    // far beyond the 14-day cap (over-long, must clamp).
    resumeOffsetMs: fc.integer({ min: -DAY_MS, max: 60 * DAY_MS }),
    isActive: fc.boolean(),
  }).map(({ userId, startsAt, resumeOffsetMs, isActive }) => ({
    userId,
    startsAt,
    resumesAt: (startsAt as number) + resumeOffsetMs,
    isActive,
  }));

  const schedulesArb = fc.array(windowArb, { minLength: 0, maxLength: 6 });

  // Independent reference oracle for the predicate (R34.2): true iff some active
  // schedule's clamped, half-open window [startsAt, clampedResumesAt) contains now.
  function expectedActive(
    schedules: readonly SanctuaryWindow[],
    now: number,
  ): boolean {
    return schedules.some((s) => {
      if (!s.isActive) return false;
      const start = s.startsAt as number;
      const clamped = clampResumesAt(s.startsAt, s.resumesAt);
      return now >= start && now < clamped;
    });
  }

  it("(a) R34.2 suppresses iff some active schedule's clamped window contains now", () => {
    fc.assert(
      fc.property(schedulesArb, instant, (schedules, now) => {
        expect(isSanctuaryActive(schedules, now)).toBe(
          expectedActive(schedules, now),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("(b) R34.4 auto-resumes at/after resumesAt and never mutates the input (idempotent)", () => {
    fc.assert(
      fc.property(schedulesArb, instant, (schedules, now) => {
        // Snapshot inputs to prove no mutation / no state write occurs.
        const before = JSON.stringify(schedules);

        const first = isSanctuaryActive(schedules, now);
        // Re-consulting is idempotent: same inputs -> same answer, no writes.
        const second = isSanctuaryActive(schedules, now);
        expect(second).toBe(first);
        expect(JSON.stringify(schedules)).toBe(before);

        // For every active schedule whose clamped resume has passed, that
        // schedule contributes nothing to suppression — evaluation resumes
        // purely as a function of the clock, with no reactivation call.
        for (const s of schedules) {
          const clamped = clampResumesAt(s.startsAt, s.resumesAt);
          if (now >= clamped) {
            // This schedule alone can never keep suppression on at `now`.
            expect(isSanctuaryActive([s], now)).toBe(false);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("(c) an over-long window never suppresses past startsAt + 14d (defensive clamp)", () => {
    // Force an over-long, active window and probe just before/after the cap.
    const overLongArb = fc.record({
      userId: fc.constantFrom("anchor-1", "anchor-2"),
      startsAt: instant,
      // resumesAt strictly beyond the 14-day cap.
      extraMs: fc.integer({ min: 1, max: 60 * DAY_MS }),
    });

    fc.assert(
      fc.property(overLongArb, (input) => {
        const start = input.startsAt;
        const cap = start + SANCTUARY_MAX_WINDOW_MS;
        const schedule: SanctuaryWindow = {
          userId: input.userId,
          startsAt: start,
          resumesAt: cap + input.extraMs, // over-long
          isActive: true,
        };

        // Inside the clamped window (just before the cap): suppressed.
        expect(isSanctuaryActive([schedule], cap - 1)).toBe(true);
        // At the cap and beyond: never suppressed, despite the over-long row.
        expect(isSanctuaryActive([schedule], cap)).toBe(false);
        expect(isSanctuaryActive([schedule], cap + input.extraMs - 1)).toBe(
          false,
        );
      }),
      { numRuns: 300 },
    );
  });

  it("(d) R34.5 streak preservation is structural — no streak state, only (schedules, now)", () => {
    // Structural marker: the module documents that no code path from the gate
    // touches Vitality_Streak.
    expect(SANCTUARY_STREAK_PRESERVED).toBe(true);

    fc.assert(
      fc.property(schedulesArb, instant, (schedules, now) => {
        // The predicate takes exactly two positional parameters — a schedule
        // set and an instant — and no streak/state channel. Its arity is a
        // structural witness that it cannot read or write streak state.
        expect(isSanctuaryActive.length).toBe(2);

        // Purity witness: extra "streak"-shaped fields on schedules and on now
        // cannot influence the answer, because the gate reads only the typed
        // window fields and the instant.
        const decoy = schedules.map((s) => ({
          ...s,
          vitalityStreak: 999,
          streakFrozen: true,
        })) as unknown as SanctuaryWindow[];
        expect(isSanctuaryActive(decoy, now)).toBe(
          isSanctuaryActive(schedules, now),
        );
      }),
      { numRuns: 300 },
    );
  });
});
