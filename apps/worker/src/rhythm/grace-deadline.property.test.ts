// Feature: kshema-safety-platform, Property 4: For all Adaptive_Rhythm_Profiles,
// day-of-week values, and prior-day step counts, the computed Grace_Deadline
// SHALL equal meanWakeMinute + 2*stdDevWakeMinute, plus 45 minutes iff the day
// is Saturday or Sunday, plus 30 minutes iff the prior-day step count exceeded
// 180% of the 30-day average, and SHALL never include any statically
// configured wake time.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FATIGUE_OFFSET_MIN,
  DEFAULT_WEEKEND_OFFSET_MIN,
  FATIGUE_STEP_RATIO,
  computeGraceDeadline,
} from "./engine.js";

/**
 * Validates: Requirements 4.3, 4.4, 4.5, 4.6
 *
 * Property 4 asserts the Grace_Deadline formula holds across arbitrary valid
 * inputs. The generators intentionally straddle the fatigue threshold (both
 * strictly above and at/below 180% of the 30-day average) and cover both
 * weekend and weekday cases, plus arbitrary custom offset overrides, so the
 * conditional-offset logic is exercised in every branch.
 */
describe("computeGraceDeadline — Property 4 (R4.3–R4.6)", () => {
  // Finite, well-behaved numeric domains. Bounds are generous but avoid
  // NaN/Infinity so exact arithmetic equality is meaningful.
  const minute = fc.double({
    min: 0,
    max: 1_440,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const stdDev = fc.double({
    min: 0,
    max: 720,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const steps = fc.double({
    min: 0,
    max: 100_000,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const offset = fc.double({
    min: 0,
    max: 240,
    noNaN: true,
    noDefaultInfinity: true,
  });

  const inputArb = fc.record({
    mean: minute,
    stdDev,
    isWeekend: fc.boolean(),
    priorDaySteps: steps,
    avgStep30d: steps,
    weekendOffsetMin: offset,
    fatigueOffsetMin: offset,
  });

  it("rawMinuteOfDay equals base + conditional offsets (R4.3, R4.4, R4.5)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const {
          mean,
          stdDev: sd,
          isWeekend,
          priorDaySteps,
          avgStep30d,
          weekendOffsetMin,
          fatigueOffsetMin,
        } = input;

        const result = computeGraceDeadline(input);

        // Expected offsets recomputed independently of the implementation.
        const expectedWeekend = isWeekend ? weekendOffsetMin : 0;
        const expectedFatigue =
          priorDaySteps > FATIGUE_STEP_RATIO * avgStep30d
            ? fatigueOffsetMin
            : 0;
        const expectedRaw =
          mean + 2 * sd + expectedWeekend + expectedFatigue;

        // R4.3–R4.5: the full formula.
        expect(result.rawMinuteOfDay).toBe(expectedRaw);

        // R4.4: weekend offset applied iff the day is a weekend.
        expect(result.appliedWeekendOffsetMin).toBe(expectedWeekend);

        // R4.5: fatigue offset applied iff prior steps strictly exceed 180%.
        expect(result.appliedFatigueOffsetMin).toBe(expectedFatigue);
      }),
      { numRuns: 200 },
    );
  });

  it("weekend offset is applied if and only if isWeekend (R4.4)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = computeGraceDeadline(input);
        if (input.isWeekend) {
          expect(result.appliedWeekendOffsetMin).toBe(input.weekendOffsetMin);
        } else {
          expect(result.appliedWeekendOffsetMin).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("fatigue offset is applied iff prior steps strictly exceed 1.8*avgStep30d (R4.5)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = computeGraceDeadline(input);
        const threshold = FATIGUE_STEP_RATIO * input.avgStep30d;
        if (input.priorDaySteps > threshold) {
          expect(result.appliedFatigueOffsetMin).toBe(input.fatigueOffsetMin);
        } else {
          // At-threshold and below never trigger the offset (strict >).
          expect(result.appliedFatigueOffsetMin).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("uses the documented default offsets when none are supplied (R4.4, R4.5)", () => {
    const inputNoOverrides = fc.record({
      mean: minute,
      stdDev,
      isWeekend: fc.boolean(),
      priorDaySteps: steps,
      avgStep30d: steps,
    });
    fc.assert(
      fc.property(inputNoOverrides, (input) => {
        const result = computeGraceDeadline(input);
        const expectedWeekend = input.isWeekend
          ? DEFAULT_WEEKEND_OFFSET_MIN
          : 0;
        const expectedFatigue =
          input.priorDaySteps > FATIGUE_STEP_RATIO * input.avgStep30d
            ? DEFAULT_FATIGUE_OFFSET_MIN
            : 0;
        expect(result.appliedWeekendOffsetMin).toBe(expectedWeekend);
        expect(result.appliedFatigueOffsetMin).toBe(expectedFatigue);
        expect(result.rawMinuteOfDay).toBe(
          input.mean + 2 * input.stdDev + expectedWeekend + expectedFatigue,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("is a pure, deterministic function of only its documented inputs — no static wake time can influence the result (R4.6)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        // R4.6: the function exposes no channel (global, clock, config, hidden
        // field) for a statically configured wake time. Determinism across
        // repeated calls with identical documented inputs — and independence
        // from anything else in scope — demonstrates the result is a pure
        // function of only { mean, stdDev, isWeekend, priorDaySteps,
        // avgStep30d, weekendOffsetMin, fatigueOffsetMin }.
        const first = computeGraceDeadline(input);
        const second = computeGraceDeadline({ ...input });
        const third = computeGraceDeadline(input);

        expect(second).toEqual(first);
        expect(third).toEqual(first);

        // A decoy "configured wake time" style property placed alongside the
        // documented inputs must be ignored: the engine reads only its typed
        // fields, so an extra key cannot shift the outcome.
        // Build the decoy through an untyped record + cast so the extra keys
        // reach the function at runtime (proving they are ignored) without a
        // compile-time excess-property error.
        const decoyInput = {
          ...input,
          configuredWakeMinute: 999,
          staticWakeTime: 1234,
        } as unknown as Parameters<typeof computeGraceDeadline>[0];
        const withDecoy = computeGraceDeadline(decoyInput);
        expect(withDecoy).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });
});
