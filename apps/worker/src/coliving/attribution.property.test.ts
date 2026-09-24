// Feature: kshema-safety-platform, Property 25: For all Co_Living_Households and
// shared Ghost_Signals (from a shared media device or shared Wi-Fi BSSID), the
// signal SHALL be attributed as "household activity confirmed", and for any
// co-living Anchor whose Sentinel_Policy requires independent confirmation the
// shared signal alone SHALL NOT confirm that Anchor's morning Routine_Rhythm —
// an individual screen unlock or step delta for that Anchor SHALL still be
// required.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ConfirmingSignal } from "../personas/confirming-signal.js";
import {
  attributeGhostSignal,
  evaluateCoLivingConfirmation,
  isHouseholdConfirmed,
  isIndividuallyConfirmed,
  isRoutineConfirmedForCoLivingAnchor,
  type GhostSignalView,
  type HouseholdProfileView,
} from "./attribution.js";

/**
 * Validates: Requirements 35.2
 *
 * Property 25 asserts the R35.2 combiner directly over the abstract truth-table
 * inputs, and end-to-end over generated Ghost_Signals + confirming signals +
 * household profiles.
 *
 * The independent oracle is the design's documented combiner:
 *
 *   confirmed = individuallyConfirmed || (householdConfirmed && !requiresIndependentConfirmation)
 *
 * which is recomputed here independently of the module under test. The GUARD
 * that R35.2 exists to enforce — `requiresIndependent && householdConfirmed &&
 * !individuallyConfirmed  ⇒  confirmed === false` (a household signal alone
 * never confirms an Anchor requiring independent confirmation) — is asserted
 * explicitly on top of the full truth-table check.
 */

/** The design's authoritative R35.2 combiner, recomputed as an oracle. */
function oracle(
  requiresIndependentConfirmation: boolean,
  householdConfirmed: boolean,
  individuallyConfirmed: boolean,
): boolean {
  return (
    individuallyConfirmed ||
    (householdConfirmed && !requiresIndependentConfirmation)
  );
}

describe("attribution — Property 25 (R35.2)", () => {
  it("the combiner matches the truth table for arbitrary boolean inputs, and honors the R35.2 guard", () => {
    const inputArb = fc.record({
      requiresIndependentConfirmation: fc.boolean(),
      householdConfirmed: fc.boolean(),
      individuallyConfirmed: fc.boolean(),
    });

    fc.assert(
      fc.property(inputArb, (input) => {
        const actual = isRoutineConfirmedForCoLivingAnchor(input);
        const expected = oracle(
          input.requiresIndependentConfirmation,
          input.householdConfirmed,
          input.individuallyConfirmed,
        );

        // Combiner equals the documented truth table.
        expect(actual).toBe(expected);

        // The R35.2 GUARD: a household signal ALONE never confirms an Anchor
        // that requires independent confirmation.
        if (
          input.requiresIndependentConfirmation &&
          input.householdConfirmed &&
          !input.individuallyConfirmed
        ) {
          expect(actual).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("end-to-end: attribution + evaluateCoLivingConfirmation match the oracle over generated signals and profiles", () => {
    // A household profile with disjoint shared/non-shared identifier pools so a
    // generated signal's HOUSEHOLD/INDIVIDUAL attribution is unambiguous and the
    // oracle can be recomputed independently from the same inputs.
    const sharedMediaId = "shared-media";
    const sharedBssid = "aa:bb:cc:dd:ee:ff";
    const privateMediaId = "private-media";
    const privateBssid = "11:22:33:44:55:66";

    const profileArb: fc.Arbitrary<HouseholdProfileView> = fc.record({
      householdName: fc.constant("Rao residence"),
      anchorIds: fc.constant(["anchor-a", "anchor-b"] as const),
      sharedWifiBssids: fc.constant([sharedBssid]),
      sharedMediaDeviceIds: fc.constant([sharedMediaId]),
    });

    // Ghost signals draw a type and a source from either the shared or the
    // non-shared pool, so both HOUSEHOLD and INDIVIDUAL attributions are hit.
    const ghostArb: fc.Arbitrary<GhostSignalView> = fc.record({
      anchorId: fc.constantFrom("anchor-a", "anchor-b"),
      signalType: fc.constantFrom<GhostSignalView["signalType"]>(
        "MEDIA_DEVICE_WAKE",
        "HOME_WIFI_REASSOCIATION",
      ),
      source: fc.constantFrom(
        sharedMediaId,
        sharedBssid,
        privateMediaId,
        privateBssid,
        "unknown-source",
      ),
    });

    // Confirming signals straddle the individual-confirmation boundary: screen
    // unlock (always individual), step_delta with positive/zero/negative deltas
    // (individual only when strictly positive), and charger_unplug/ghost_signal
    // (never individual per R35.2's stricter rule).
    const confirmingArb: fc.Arbitrary<ConfirmingSignal> = fc
      .record({
        type: fc.constantFrom<ConfirmingSignal["type"]>(
          "screen_unlock",
          "step_delta",
          "charger_unplug",
          "ghost_signal",
        ),
        at: fc.integer({ min: 0, max: 10_000 }),
        stepDelta: fc.integer({ min: -50, max: 50 }),
      })
      .map(({ type, at, stepDelta }) =>
        type === "step_delta" ? { type, at, stepDelta } : { type, at },
      );

    const scenarioArb = fc.record({
      requiresIndependentConfirmation: fc.boolean(),
      profile: profileArb,
      ghostSignals: fc.array(ghostArb, { maxLength: 8 }),
      confirmingSignals: fc.array(confirmingArb, { maxLength: 8 }),
    });

    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const actual = evaluateCoLivingConfirmation(scenario);

        // Independent oracle: derive household/individual flags from the same
        // per-signal predicates the design specifies, then apply the combiner.
        const householdConfirmed = scenario.ghostSignals.some((g) =>
          isHouseholdConfirmed(g, scenario.profile),
        );
        const individuallyConfirmed = isIndividuallyConfirmed(
          scenario.confirmingSignals,
        );
        const expected = oracle(
          scenario.requiresIndependentConfirmation,
          householdConfirmed,
          individuallyConfirmed,
        );

        expect(actual).toBe(expected);

        // Every ghost signal is attributed HOUSEHOLD exactly when its source is
        // in the household's shared pool (R35.1/R35.2 attribution).
        for (const g of scenario.ghostSignals) {
          const sharedPool =
            g.signalType === "MEDIA_DEVICE_WAKE"
              ? scenario.profile.sharedMediaDeviceIds
              : scenario.profile.sharedWifiBssids;
          const expectedAttribution = sharedPool.includes(g.source)
            ? "HOUSEHOLD"
            : "INDIVIDUAL";
          expect(attributeGhostSignal(g, scenario.profile)).toBe(
            expectedAttribution,
          );
        }

        // The R35.2 GUARD end-to-end: when the Anchor requires independent
        // confirmation and only household activity is present (no individual
        // signal), the routine is NOT confirmed.
        if (
          scenario.requiresIndependentConfirmation &&
          householdConfirmed &&
          !individuallyConfirmed
        ) {
          expect(actual).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
