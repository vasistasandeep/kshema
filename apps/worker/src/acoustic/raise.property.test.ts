// Feature: kshema-safety-platform, Property 13: For all tuples of (confidence,
// sustained duration, motionless duration), a Safety_Incident at STAGE_2 SHALL
// be raised if and only if confidence > 0.82 AND sustained > 1.5s AND
// motionless >= 30s.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ACOUSTIC_CONFIDENCE_THRESHOLD,
  ACOUSTIC_MOTIONLESS_THRESHOLD_SEC,
  ACOUSTIC_SUSTAINED_THRESHOLD_SEC,
  shouldRaiseAcousticIncident,
  type AcousticSignal,
} from "./raise.js";

/**
 * Validates: Requirements 10.3, 10.4
 *
 * Property 13 asserts the acoustic-distress gating predicate is `true` exactly
 * when all three thresholds hold with their documented strictness:
 *   - confidence > 0.82   (strict — R10.4 excludes 0.82 and below),
 *   - sustainedSec > 1.5  (strict), and
 *   - motionlessSec >= 30 (inclusive).
 *
 * The design's baseline generators are `fc.float(0,1)`, `fc.float(0,5)`,
 * `fc.integer(0,120)`. Those alone rarely land *exactly* on a boundary, so we
 * union them with narrow generators that straddle each threshold (values just
 * below, exactly at, and just above 0.82 / 1.5 / 30). This guarantees the
 * strict-vs-inclusive distinctions are exercised, not merely sampled.
 *
 * The expected result is recomputed from an independent oracle rather than
 * re-using the implementation's own comparison, so the test would catch a
 * strictness flip (e.g. `>=` where `>` is required).
 */
describe("shouldRaiseAcousticIncident — Property 13 (R10.3, R10.4)", () => {
  // Independent oracle: mirrors the acceptance criteria without calling the
  // implementation. Strict on confidence & sustained, inclusive on motionless.
  const oracle = (s: AcousticSignal): boolean =>
    s.confidence > 0.82 && s.sustainedSec > 1.5 && s.motionlessSec >= 30;

  // Baseline generators from the design.
  const baselineConfidence = fc.float({ min: 0, max: 1, noNaN: true });
  const baselineSustained = fc.float({ min: 0, max: 5, noNaN: true });
  const baselineMotionless = fc.integer({ min: 0, max: 120 });

  // Boundary-straddling generators: values clustered tightly around each
  // threshold so the exact-boundary and just-off-boundary cases are hit often.
  const straddle = (center: number, span: number) =>
    fc.float({
      min: Math.fround(center - span),
      max: Math.fround(center + span),
      noNaN: true,
    });

  const confidenceArb = fc.oneof(
    baselineConfidence,
    straddle(ACOUSTIC_CONFIDENCE_THRESHOLD, 0.01),
    fc.constant(ACOUSTIC_CONFIDENCE_THRESHOLD), // exactly 0.82 (must exclude)
  );
  const sustainedArb = fc.oneof(
    baselineSustained,
    straddle(ACOUSTIC_SUSTAINED_THRESHOLD_SEC, 0.05),
    fc.constant(ACOUSTIC_SUSTAINED_THRESHOLD_SEC), // exactly 1.5 (must exclude)
  );
  const motionlessArb = fc.oneof(
    baselineMotionless,
    straddle(ACOUSTIC_MOTIONLESS_THRESHOLD_SEC, 1),
    fc.constant(ACOUSTIC_MOTIONLESS_THRESHOLD_SEC), // exactly 30 (must include)
  );

  const signalArb: fc.Arbitrary<AcousticSignal> = fc.record({
    confidence: confidenceArb,
    sustainedSec: sustainedArb,
    motionlessSec: motionlessArb,
  });

  it("raises iff confidence>0.82 AND sustained>1.5 AND motionless>=30 (R10.3, R10.4)", () => {
    fc.assert(
      fc.property(signalArb, (signal) => {
        expect(shouldRaiseAcousticIncident(signal)).toBe(oracle(signal));
      }),
      { numRuns: 500 },
    );
  });

  it("never raises when confidence is at or below 0.82 (R10.4 strict boundary)", () => {
    // confidence pinned to <= 0.82; the other two are free to qualify or not.
    const subConfidenceArb = fc.record({
      confidence: fc.oneof(
        fc.float({ min: 0, max: Math.fround(0.82), noNaN: true }),
        fc.constant(ACOUSTIC_CONFIDENCE_THRESHOLD),
      ),
      sustainedSec: sustainedArb,
      motionlessSec: motionlessArb,
    });
    fc.assert(
      fc.property(subConfidenceArb, (signal) => {
        expect(shouldRaiseAcousticIncident(signal)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("requires all three thresholds — clearing any two alone never raises (R10.3)", () => {
    // Qualifying values for each dimension, and a value that fails each.
    const passConf = fc.float({ min: Math.fround(0.821), max: 1, noNaN: true });
    const failConf = fc.float({ min: 0, max: Math.fround(0.82), noNaN: true });
    const passSust = fc.float({ min: Math.fround(1.51), max: 5, noNaN: true });
    const failSust = fc.float({ min: 0, max: Math.fround(1.5), noNaN: true });
    const passMot = fc.integer({ min: 30, max: 120 });
    const failMot = fc.integer({ min: 0, max: 29 });

    // Exactly one dimension fails at a time — each must sink the whole gate.
    const confFails = fc.record({ confidence: failConf, sustainedSec: passSust, motionlessSec: passMot });
    const sustFails = fc.record({ confidence: passConf, sustainedSec: failSust, motionlessSec: passMot });
    const motFails = fc.record({ confidence: passConf, sustainedSec: passSust, motionlessSec: failMot });

    fc.assert(
      fc.property(fc.oneof(confFails, sustFails, motFails), (signal) => {
        expect(shouldRaiseAcousticIncident(signal)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("raises when all three thresholds are strictly/inclusively cleared (R10.3)", () => {
    const qualifyingArb = fc.record({
      confidence: fc.float({ min: Math.fround(0.821), max: 1, noNaN: true }),
      sustainedSec: fc.float({ min: Math.fround(1.51), max: 5, noNaN: true }),
      motionlessSec: fc.integer({ min: 30, max: 120 }), // inclusive lower bound
    });
    fc.assert(
      fc.property(qualifyingArb, (signal) => {
        expect(shouldRaiseAcousticIncident(signal)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
