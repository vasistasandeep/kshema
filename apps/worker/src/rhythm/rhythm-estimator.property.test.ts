// Feature: kshema-safety-platform, Property 5: Rhythm estimator over partial samples
/**
 * Property 5: Rhythm estimator over partial samples.
 *
 * *For all* sample sets of observed wake events, the engine SHALL compute the
 * baseline mean and standard deviation from exactly the effective rolling window
 * (the most recent {@link ROLLING_WINDOW_DAYS} = 14 samples) and SHALL do so
 * using ONLY observed samples — never a statically configured wake time.
 *
 * This suite exercises arbitrary partial (<14) AND over-full (>14) sample
 * arrays so the rolling-window cap, the population-standard-deviation rule, the
 * single-sample (stdDev = 0) case, the empty ({0,0,0}) case, and determinism
 * are all covered:
 *  - `mean` equals the arithmetic mean of the effective window,
 *  - `stdDev` equals the population standard deviation (÷N) of that window,
 *    is exactly 0 for a single-sample window, and 0 for the empty window,
 *  - `sampleCount === min(inputLength, 14)`,
 *  - the estimator is deterministic: the same samples yield the same baseline,
 *  - `mean` stays within [min(window), max(window)] and `stdDev >= 0`.
 *
 * Samples are minute-of-day values in [0, 1439] (R4.2). The reference mean/
 * stdDev here are computed independently from the engine to guard against the
 * engine simply agreeing with itself.
 *
 * Validates: Requirements 4.1, 4.2, 4.7
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { ROLLING_WINDOW_DAYS, computeBaseline } from "./engine.js";

/** Minute-of-day sample: 00:00 (0) through 23:59 (1439). */
const minuteOfDayArb = fc.integer({ min: 0, max: 1439 });

/**
 * Arbitrary wake-sample arrays spanning the full range that matters:
 *  - length 0 (empty -> {0,0,0}),
 *  - length 1 (single sample -> stdDev 0),
 *  - partial windows (2..13),
 *  - exactly 14,
 *  - over-full (>14) to exercise the rolling-window eviction/cap.
 * maxLength 40 comfortably exceeds 2x the 14-sample window.
 */
const samplesArb = fc.array(minuteOfDayArb, { minLength: 0, maxLength: 40 });

/** The effective window the engine should use: the most recent 14 samples. */
function effectiveWindow(samples: readonly number[]): number[] {
  return samples.length > ROLLING_WINDOW_DAYS
    ? samples.slice(samples.length - ROLLING_WINDOW_DAYS)
    : samples.slice();
}

/** Independent arithmetic mean reference. */
function refMean(window: readonly number[]): number {
  if (window.length === 0) return 0;
  return window.reduce((a, v) => a + v, 0) / window.length;
}

/** Independent population standard deviation (÷N) reference. */
function refPopulationStdDev(window: readonly number[]): number {
  if (window.length === 0) return 0;
  const m = refMean(window);
  const variance =
    window.reduce((a, v) => a + (v - m) * (v - m), 0) / window.length;
  return Math.sqrt(variance);
}

describe("Property 5: rhythm estimator over partial samples", () => {
  it("computes mean/stdDev/sampleCount from exactly the effective window using only observed samples", () => {
    fc.assert(
      fc.property(samplesArb, (samples) => {
        const window = effectiveWindow(samples);
        const baseline = computeBaseline(samples);

        // sampleCount == min(inputLength, 14)
        expect(baseline.sampleCount).toBe(
          Math.min(samples.length, ROLLING_WINDOW_DAYS),
        );

        if (samples.length === 0) {
          // Empty -> zero baseline (R4.7).
          expect(baseline).toEqual({ mean: 0, stdDev: 0, sampleCount: 0 });
          return true;
        }

        // mean equals the arithmetic mean of the effective window.
        expect(baseline.mean).toBeCloseTo(refMean(window), 9);

        // stdDev equals the population standard deviation of that window,
        // and is exactly 0 for a single-sample window (R4.7).
        if (window.length === 1) {
          expect(baseline.stdDev).toBe(0);
        } else {
          expect(baseline.stdDev).toBeCloseTo(refPopulationStdDev(window), 9);
        }

        // stdDev is never negative.
        expect(baseline.stdDev).toBeGreaterThanOrEqual(0);

        // mean stays within [min(window), max(window)].
        const lo = Math.min(...window);
        const hi = Math.max(...window);
        expect(baseline.mean).toBeGreaterThanOrEqual(lo);
        expect(baseline.mean).toBeLessThanOrEqual(hi);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("is deterministic: identical samples always yield an identical baseline", () => {
    fc.assert(
      fc.property(samplesArb, (samples) => {
        const first = computeBaseline(samples);
        // Re-run over a fresh copy: no reliance on any static/config wake time
        // or hidden mutable state — the result depends only on the samples.
        const second = computeBaseline(samples.slice());
        expect(second).toEqual(first);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
