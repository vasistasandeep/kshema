// Feature: kshema-safety-platform, Property 22: Bedtime battery thresholds.
// For all (batteryLevel, chargerState, phase) tuples, a gentle bedtime chime
// SHALL be emitted if and only if `phase = BEDTIME_MINUS_60` and
// `batteryLevel < 25` and `chargerState = UNPLUGGED`; and a pre-dawn battery
// exhaustion warning SHALL be logged if and only if `phase = POST_MIDNIGHT`
// and `batteryLevel < 15` and `chargerState = UNPLUGGED`.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BEDTIME_LOW_THRESHOLD,
  PRE_DAWN_EXHAUSTION_THRESHOLD,
  type ChargerState,
  type GuardianPhase,
  evaluateBatteryGuardian,
} from "./guardian.js";

/**
 * Validates: Requirements 32.2, 32.3
 *
 * Property 22 asserts, across arbitrary (phase, batteryLevel, chargerState)
 * tuples, that the pure guardian decision is a faithful IFF of the two
 * threshold rules:
 *   - `bedtime_chime` iff phase = BEDTIME_MINUS_60 AND battery < 25 AND
 *     UNPLUGGED (R32.2);
 *   - `pre_dawn_warning` iff phase = POST_MIDNIGHT AND battery < 15 AND
 *     UNPLUGGED (R32.3);
 *   - `none` for every other tuple.
 *
 * The generator straddles both thresholds (0..100 includes the exact boundaries
 * 25 and 15), both charger states, and phases beyond the two actionable ones so
 * the wrong-phase, plugged-in, at/above-threshold, and boundary branches are
 * all exercised. Thresholds are strict, so exactly 25% / 15% must resolve to
 * `none`.
 */
describe("evaluateBatteryGuardian — Property 22 (R32.2/R32.3)", () => {
  // Phase domain: both actionable phases plus decoy phases that must never fire.
  const phaseArb: fc.Arbitrary<GuardianPhase> = fc.constantFrom<GuardianPhase>(
    "BEDTIME_MINUS_60",
    "POST_MIDNIGHT",
    "MIDDAY",
    "MORNING_CHECK",
    "EVENING",
  );

  const batteryArb = fc.integer({ min: 0, max: 100 });
  const chargerArb: fc.Arbitrary<ChargerState> = fc.constantFrom<ChargerState>(
    "PLUGGED",
    "UNPLUGGED",
  );

  // Independent reference oracle for the expected decision action.
  function expectedAction(
    phase: GuardianPhase,
    batteryLevel: number,
    chargerState: ChargerState,
  ): "bedtime_chime" | "pre_dawn_warning" | "none" {
    const unplugged = chargerState === "UNPLUGGED";
    if (phase === "BEDTIME_MINUS_60" && unplugged && batteryLevel < BEDTIME_LOW_THRESHOLD) {
      return "bedtime_chime";
    }
    if (phase === "POST_MIDNIGHT" && unplugged && batteryLevel < PRE_DAWN_EXHAUSTION_THRESHOLD) {
      return "pre_dawn_warning";
    }
    return "none";
  }

  it("(a) the decision matches the IFF spec for every (phase, battery, charger) tuple", () => {
    fc.assert(
      fc.property(phaseArb, batteryArb, chargerArb, (phase, batteryLevel, chargerState) => {
        const decision = evaluateBatteryGuardian({ phase, batteryLevel, chargerState });
        expect(decision.action).toBe(expectedAction(phase, batteryLevel, chargerState));

        // The decision shape must stay internally consistent with its action.
        if (decision.action === "bedtime_chime") {
          expect(decision.chime).toBe(true);
          expect(decision.logKind).toBe("BEDTIME_LOW");
          expect(decision.notifyObserver).toBe(false);
        } else if (decision.action === "pre_dawn_warning") {
          expect(decision.chime).toBe(false);
          expect(decision.logKind).toBe("PRE_DAWN_BATTERY_EXHAUSTION_WARNING");
          expect(decision.notifyObserver).toBe(true);
        } else {
          expect(decision.chime).toBe(false);
          expect(decision.logKind).toBe(null);
          expect(decision.notifyObserver).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("(b) plugged-in never fires, regardless of phase or battery level", () => {
    fc.assert(
      fc.property(phaseArb, batteryArb, (phase, batteryLevel) => {
        expect(
          evaluateBatteryGuardian({ phase, batteryLevel, chargerState: "PLUGGED" }).action,
        ).toBe("none");
      }),
      { numRuns: 200 },
    );
  });

  it("(c) at/above threshold never fires for its phase (strict thresholds)", () => {
    // Bedtime: battery >= 25 -> none even unplugged at BEDTIME_MINUS_60.
    fc.assert(
      fc.property(fc.integer({ min: BEDTIME_LOW_THRESHOLD, max: 100 }), (battery) => {
        expect(
          evaluateBatteryGuardian({
            phase: "BEDTIME_MINUS_60",
            batteryLevel: battery,
            chargerState: "UNPLUGGED",
          }).action,
        ).toBe("none");
      }),
      { numRuns: 100 },
    );

    // Pre-dawn: battery >= 15 -> none even unplugged at POST_MIDNIGHT.
    fc.assert(
      fc.property(fc.integer({ min: PRE_DAWN_EXHAUSTION_THRESHOLD, max: 100 }), (battery) => {
        expect(
          evaluateBatteryGuardian({
            phase: "POST_MIDNIGHT",
            batteryLevel: battery,
            chargerState: "UNPLUGGED",
          }).action,
        ).toBe("none");
      }),
      { numRuns: 100 },
    );
  });

  it("(d) a wrong phase never fires, even unplugged and at 0%", () => {
    const wrongPhaseArb = fc.constantFrom<GuardianPhase>(
      "MIDDAY",
      "MORNING_CHECK",
      "EVENING",
      "UNKNOWN",
    );
    fc.assert(
      fc.property(wrongPhaseArb, batteryArb, chargerArb, (phase, batteryLevel, chargerState) => {
        expect(
          evaluateBatteryGuardian({ phase, batteryLevel, chargerState }).action,
        ).toBe("none");
      }),
      { numRuns: 200 },
    );
  });

  it("(e) the exact boundaries (25 and 15) never fire (strict '<')", () => {
    // Exactly 25% at bedtime, unplugged -> none.
    expect(
      evaluateBatteryGuardian({
        phase: "BEDTIME_MINUS_60",
        batteryLevel: BEDTIME_LOW_THRESHOLD,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");

    // Exactly 15% post-midnight, unplugged -> none.
    expect(
      evaluateBatteryGuardian({
        phase: "POST_MIDNIGHT",
        batteryLevel: PRE_DAWN_EXHAUSTION_THRESHOLD,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");
  });
});
