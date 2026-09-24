// Feature: kshema-safety-platform, Property 9: For all pending morning
// Routine_Rhythm checks, if any confirming signal (screen unlock, positive step
// delta, charger unplug, or Ghost_Signal) is received strictly before the
// Grace_Deadline, the check SHALL be marked confirmed and no Safety_Incident
// SHALL open for that check; conversely, if no confirming signal arrives before
// the deadline the check stays unconfirmed and would escalate.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyConfirmingSignals,
  createGraceCheckState,
  isBeforeDeadline,
  isConfirmingSignal,
  shouldEscalate,
  type ConfirmingSignal,
  type ConfirmingSignalType,
} from "./confirming-signal.js";

/**
 * Validates: Requirements 5.6, 6.4, 6.5
 *
 * Property 9 asserts the confirmation gate across an arbitrary pending
 * grace-check and an arbitrary sequence of signals. The generators intentionally
 * straddle the deadline (arrival times both before and at/after it) and produce
 * `step_delta` signals with zero/negative (non-confirming) and strictly positive
 * (confirming) deltas, so `isConfirmingSignal`'s positive-delta rule and
 * `isBeforeDeadline`'s strict-before rule are both exercised. The oracle for
 * whether the fold should confirm is recomputed independently of the module
 * under test from the same per-signal predicates the design specifies.
 */
describe("confirming-signal — Property 9 (R5.6, R6.4, R6.5)", () => {
  const signalType: fc.Arbitrary<ConfirmingSignalType> = fc.constantFrom(
    "screen_unlock",
    "step_delta",
    "charger_unplug",
    "ghost_signal",
  );

  // A finite, well-behaved instant domain. The deadline is drawn from the same
  // range so a meaningful fraction of signals land on either side of it.
  const instant = fc.integer({ min: 0, max: 10_000 });

  // Step delta straddles the confirming boundary: negative, zero, and positive.
  const stepDelta = fc.integer({ min: -50, max: 50 });

  const signalArb: fc.Arbitrary<ConfirmingSignal> = fc
    .record({
      type: signalType,
      at: instant,
      stepDelta,
    })
    .map(({ type, at, stepDelta: delta }) =>
      // Only attach stepDelta for step_delta signals so other types confirm by
      // occurrence, matching how the ingestion handlers construct signals.
      type === "step_delta"
        ? { type, at, stepDelta: delta }
        : { type, at },
    );

  const scenarioArb = fc.record({
    anchorId: fc.string({ minLength: 1, maxLength: 12 }),
    serviceDay: fc.constant("2025-01-31"),
    deadline: instant,
    signals: fc.array(signalArb, { maxLength: 20 }),
  });

  it("confirms (and prevents escalation) iff some confirming signal arrives strictly before the deadline", () => {
    fc.assert(
      fc.property(scenarioArb, ({ anchorId, serviceDay, deadline, signals }) => {
        const state = createGraceCheckState({ anchorId, serviceDay, deadline });
        const result = applyConfirmingSignals(state, signals);

        // Independent oracle: a check should confirm exactly when at least one
        // signal is both a confirming signal and strictly before the deadline.
        const expectedConfirmed = signals.some(
          (s) => isConfirmingSignal(s) && isBeforeDeadline(s, deadline),
        );

        // R5.6/R6.4: confirmation matches the confirming-signal-before-deadline rule.
        expect(result.confirmed).toBe(expectedConfirmed);

        // R6.5: a confirmed check must NOT escalate; an unconfirmed one must.
        expect(shouldEscalate(result)).toBe(!expectedConfirmed);

        if (expectedConfirmed) {
          // The retained signal is itself a confirming, on-time signal.
          expect(result.confirmedBy).toBeDefined();
          const by = result.confirmedBy as ConfirmingSignal;
          expect(isConfirmingSignal(by)).toBe(true);
          expect(isBeforeDeadline(by, deadline)).toBe(true);
        } else {
          expect(result.confirmedBy).toBeUndefined();
        }
      }),
      { numRuns: 200 },
    );
  });

  it("prevents escalation when at least one confirming signal is guaranteed before the deadline (R6.5)", () => {
    // Build scenarios that always contain a confirming, on-time signal, then
    // interleave arbitrary noise (including late and non-confirming signals).
    const guaranteedArb = fc
      .record({
        deadline: fc.integer({ min: 1, max: 10_000 }),
        noise: fc.array(signalArb, { maxLength: 15 }),
      })
      .chain(({ deadline, noise }) =>
        fc
          .record({
            confirmingType: fc.constantFrom<ConfirmingSignalType>(
              "screen_unlock",
              "charger_unplug",
              "ghost_signal",
              "step_delta",
            ),
            at: fc.integer({ min: 0, max: deadline - 1 }),
            positiveDelta: fc.integer({ min: 1, max: 50 }),
            insertAt: fc.integer({ min: 0, max: noise.length }),
          })
          .map(({ confirmingType, at, positiveDelta, insertAt }) => {
            const confirming: ConfirmingSignal =
              confirmingType === "step_delta"
                ? { type: "step_delta", at, stepDelta: positiveDelta }
                : { type: confirmingType, at };
            const signals = [...noise];
            signals.splice(insertAt, 0, confirming);
            return { deadline, signals };
          }),
      );

    fc.assert(
      fc.property(guaranteedArb, ({ deadline, signals }) => {
        const state = createGraceCheckState({
          anchorId: "anchor",
          serviceDay: "2025-01-31",
          deadline,
        });
        const result = applyConfirmingSignals(state, signals);
        expect(result.confirmed).toBe(true);
        expect(shouldEscalate(result)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("stays unconfirmed and would escalate when no confirming signal precedes the deadline (R5.6, R6.5)", () => {
    // Every signal is deliberately either non-confirming (zero/negative step
    // delta) or arrives at/after the deadline, so the check must never confirm.
    const noConfirmArb = fc
      .record({
        deadline: fc.integer({ min: 0, max: 10_000 }),
        count: fc.integer({ min: 0, max: 15 }),
      })
      .chain(({ deadline, count }) =>
        fc
          .array(
            fc.oneof(
              // Non-confirming step_delta at any time (zero or negative delta).
              fc.record({
                type: fc.constant<ConfirmingSignalType>("step_delta"),
                at: instant,
                stepDelta: fc.integer({ min: -50, max: 0 }),
              }),
              // Any confirming *type* but at/after the deadline (too late).
              fc.record({
                type: signalType,
                at: fc.integer({ min: deadline, max: deadline + 5_000 }),
                stepDelta: fc.integer({ min: 1, max: 50 }),
              }),
            ),
            { minLength: count, maxLength: count },
          )
          .map((raw) => ({
            deadline,
            signals: raw.map((s) =>
              s.type === "step_delta"
                ? ({ type: s.type, at: s.at, stepDelta: s.stepDelta } as ConfirmingSignal)
                : ({ type: s.type, at: s.at } as ConfirmingSignal),
            ),
          })),
      );

    fc.assert(
      fc.property(noConfirmArb, ({ deadline, signals }) => {
        const state = createGraceCheckState({
          anchorId: "anchor",
          serviceDay: "2025-01-31",
          deadline,
        });
        const result = applyConfirmingSignals(state, signals);
        expect(result.confirmed).toBe(false);
        expect(result.confirmedBy).toBeUndefined();
        // Given the mode would otherwise escalate, an unconfirmed check does.
        expect(shouldEscalate(result)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
