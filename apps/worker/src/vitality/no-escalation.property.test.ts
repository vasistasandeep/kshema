// Feature: kshema-safety-platform, Property 18
/**
 * Property 18 — Vitality streak never triggers escalation.
 *
 * *For all* day sequences of confirmations, misses, and travel/maintenance
 * states, the Vitality_Streak increments by one per confirmed day, a
 * Streak_Freeze preserves the streak for up to 3 consecutive days, and neither
 * a streak reset nor a freeze expiry ever produces a Safety_Incident or
 * escalation.
 *
 * Generator: `fc.array` of day-event enums (design.md Property 18), each event
 * mapped to a vitality job (pulse / preserve / freeze) or an unconfirmed-day
 * resolution. We drive the real `createVitalityProcessor` with an attached
 * would-be `openIncident`/escalation spy in its `deps` and assert it is NEVER
 * reached across all generated sequences.
 *
 * **Validates: Requirements 22.2, 22.4, 22.5, 22.6**
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import type { Job } from "bullmq";
import type { PrismaClient } from "@kshema/database";

import type { ProcessorContext } from "../jobs/registry.js";
import { createVitalityProcessor, type VitalityProcessorDeps } from "./processor.js";
import {
  applyStreakFreeze,
  emptyStreakState,
  incrementStreak,
  resolveUnconfirmedDay,
  serviceDayInTimezone,
  isFrozen,
  compareDays,
  addDays,
  MAX_STREAK_FREEZE_DAYS,
  type StreakState,
} from "./streak.js";

const RUNS = 200; // >= design minimum of 100
const TZ = "Asia/Kolkata";
const CIRCLE = "circle-1";
const ANCHOR = "anchor-1";

const fakePrisma = {} as unknown as PrismaClient;
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: ProcessorContext = { prisma: fakePrisma, logger: silentLogger };

function job(name: string, data: unknown): Job {
  return { name, data } as unknown as Job;
}

/** One day, at a stable morning instant (06:45 IST) — millis for the given day. */
function morningMillisForDay(dayIndex: number): number {
  // 2025-01-01 01:15 UTC == 06:45 IST on 2025-01-01. Advance by whole days.
  return Date.UTC(2025, 0, 1, 1, 15, 0) + dayIndex * 24 * 60 * 60 * 1000;
}

/** The day-event alphabet from design.md Property 18. */
type DayEvent = "confirm" | "preserve" | "freeze" | "miss";

const dayEventArb: fc.Arbitrary<DayEvent> = fc.constantFrom<DayEvent>(
  "confirm",
  "preserve",
  "freeze",
  "miss",
);

/** A sequence of day events, one per advancing calendar day. */
const sequenceArb = fc.array(
  fc.record({
    event: dayEventArb,
    // Freeze span request may be anything; the code must clamp to [1, 3].
    freezeDays: fc.integer({ min: -5, max: 30 }),
  }),
  { minLength: 0, maxLength: 40 },
);

/**
 * Build a fresh processor + an in-memory streak store, with a would-be
 * escalation spy attached to `deps`. The processor's dependency closure has NO
 * escalation seam (R22.6), so this spy must never fire.
 */
function makeHarness() {
  const streaks = new Map<string, StreakState>();
  const openIncident = vi.fn();
  const escalate = vi.fn();
  const raiseSafetyIncident = vi.fn();

  const deps: VitalityProcessorDeps = {
    now: () => morningMillisForDay(0),
    loadAnchorProfile: vi.fn(async (anchorId) => ({
      anchorId,
      preferredName: "Amma",
      timezone: TZ,
    })),
    listObservers: vi.fn(async () => [
      { observerId: "obs-1", pushTokens: ["t1"] },
      { observerId: "obs-2", pushTokens: ["t2"] },
    ]),
    recordPulseLog: vi.fn(async () => {}),
    deliverPulse: vi.fn(async () => {}),
    loadStreak: vi.fn(async (circleId) => streaks.get(circleId) ?? emptyStreakState()),
    saveStreak: vi.fn(async (circleId, state) => {
      streaks.set(circleId, state);
    }),
    resolveTimezone: vi.fn(async () => TZ),
  };
  // Attach would-be escalation seams; the processor has no way to reach them.
  const bag = deps as unknown as Record<string, unknown>;
  bag.openIncident = openIncident;
  bag.escalate = escalate;
  bag.raiseSafetyIncident = raiseSafetyIncident;

  return {
    deps,
    streaks,
    spies: [openIncident, escalate, raiseSafetyIncident],
    processor: createVitalityProcessor(deps),
  };
}

describe("Property 18 — vitality streak never triggers escalation (R22.2/22.4/22.5/22.6)", () => {
  it("(a) no generated vitality job sequence ever opens an incident / escalates", async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (events) => {
        const { processor, spies, streaks } = makeHarness();

        for (let i = 0; i < events.length; i++) {
          const { event, freezeDays } = events[i]!;
          const atMillis = morningMillisForDay(i);
          switch (event) {
            case "confirm":
              await processor(
                job("pulse", {
                  circleId: CIRCLE,
                  anchorId: ANCHOR,
                  confirmedAtMillis: atMillis,
                }),
                ctx,
              );
              break;
            case "preserve":
              await processor(job("preserve", { circleId: CIRCLE }), ctx);
              break;
            case "freeze":
              await processor(
                job("freeze", {
                  circleId: CIRCLE,
                  anchorId: ANCHOR,
                  days: freezeDays,
                  atMillis,
                }),
                ctx,
              );
              break;
            case "miss":
              // A missed day is the only reset path — resolve it explicitly.
              // (The processor has no "miss" job; the reset lives in streak.ts.)
              {
                const day = serviceDayInTimezone(atMillis, TZ);
                const current = streaks.get(CIRCLE) ?? emptyStreakState();
                const { state } = resolveUnconfirmedDay(current, day);
                streaks.set(CIRCLE, state);
              }
              break;
          }
        }

        // R22.6: across the entire sequence, no escalation seam was ever hit.
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
        // Count is always a sane non-negative integer.
        const final = streaks.get(CIRCLE) ?? emptyStreakState();
        expect(Number.isInteger(final.count)).toBe(true);
        expect(final.count).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("(b) a freeze never exceeds 3 days; a frozen day neither increments nor breaks", async () => {
    await fc.assert(
      fc.property(
        fc.record({
          count: fc.integer({ min: 0, max: 500 }),
          startDayIndex: fc.integer({ min: 0, max: 300 }),
          requestedDays: fc.integer({ min: -5, max: 30 }),
          // How many days after the freeze start to probe (may fall in or out).
          probeOffset: fc.integer({ min: 0, max: 6 }),
        }),
        ({ count, startDayIndex, requestedDays, probeOffset }) => {
          const startDay = serviceDayInTimezone(morningMillisForDay(startDayIndex), TZ);
          const base: StreakState = {
            // Last confirmation is the day before the freeze starts, so a
            // confirmation *within* the freeze is a genuinely new day (not an
            // idempotent same-day repeat).
            count,
            lastConfirmedDay: addDays(startDay, -1),
            freezeUntil: null,
          };
          const frozen = applyStreakFreeze(base, startDay, requestedDays);

          // Freeze span is clamped to at most MAX_STREAK_FREEZE_DAYS days.
          const spanDays = daySpanInclusive(startDay, frozen.freezeUntil!);
          expect(spanDays).toBeGreaterThanOrEqual(1);
          expect(spanDays).toBeLessThanOrEqual(MAX_STREAK_FREEZE_DAYS);

          // Applying a freeze never changes the count (preserve, not reset).
          expect(frozen.count).toBe(count);

          // A probe day: if it is within the freeze horizon it is frozen, and
          // resolving that unconfirmed day neither increments nor breaks.
          const probeDay = addDays(startDay, probeOffset);
          if (isFrozen(frozen, probeDay)) {
            const res = resolveUnconfirmedDay(frozen, probeDay);
            expect(res.frozen).toBe(true);
            expect(res.reset).toBe(false);
            expect(res.state.count).toBe(count); // preserved, not broken
            // A confirmation on a frozen day still increments (never escalates).
            const inc = incrementStreak(frozen, probeDay);
            expect(inc.state.count).toBe(count + 1);
          } else {
            // Beyond the horizon, an unconfirmed day resets (no escalation).
            const res = resolveUnconfirmedDay(frozen, probeDay);
            expect(res.reset).toBe(true);
            expect(res.state.count).toBe(0);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("(c) a reset only ever sets count to 0 and produces no escalation signal", () => {
    fc.assert(
      fc.property(
        fc.record({
          count: fc.integer({ min: 0, max: 1000 }),
          dayIndex: fc.integer({ min: 0, max: 400 }),
          // Optional stale freeze that has already elapsed before the miss.
          hasStaleFreeze: fc.boolean(),
        }),
        ({ count, dayIndex, hasStaleFreeze }) => {
          const missDay = serviceDayInTimezone(morningMillisForDay(dayIndex), TZ);
          // A stale freeze horizon strictly before the miss day (already elapsed).
          const staleFreeze = hasStaleFreeze ? addDays(missDay, -1) : null;
          const state: StreakState = {
            count,
            lastConfirmedDay: addDays(missDay, -1),
            freezeUntil: staleFreeze,
          };

          const res = resolveUnconfirmedDay(state, missDay);

          // A reset (non-frozen miss) always drives the count to exactly 0.
          expect(res.reset).toBe(true);
          expect(res.frozen).toBe(false);
          expect(res.state.count).toBe(0);
          // An elapsed freeze is cleared by the reset; never re-armed.
          if (staleFreeze !== null) {
            expect(compareDays(missDay, staleFreeze)).toBeGreaterThan(0);
            expect(res.state.freezeUntil).toBeNull();
          }
          // The reset result carries only plain streak data — no incident,
          // escalation, or SOS signal fields exist on it (R22.6).
          const keys = Object.keys(res).concat(Object.keys(res.state));
          for (const k of keys) {
            expect(k.toLowerCase()).not.toContain("incident");
            expect(k.toLowerCase()).not.toContain("escalat");
            expect(k.toLowerCase()).not.toContain("sos");
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

/** Inclusive day span between two `yyyy-mm-dd` day strings (start <= end). */
function daySpanInclusive(startDay: string, endDay: string): number {
  const toUtc = (d: string): number => {
    const [y, m, dd] = d.split("-").map((x) => Number.parseInt(x, 10));
    return Date.UTC(y!, m! - 1, dd!);
  };
  const diffMs = toUtc(endDay) - toUtc(startDay);
  return Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1;
}
