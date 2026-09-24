// Feature: kshema-safety-platform, Property 10: Subscription tier transitions.
// For all Subscriptions and any sequence of lifecycle events (trial expiry, Pro
// purchase, admin trial extension), the tier SHALL follow only the allowed
// transitions TRIAL->PRO, TRIAL->SHIELD_PAUSED, SHIELD_PAUSED->PRO,
// SHIELD_PAUSED->TRIAL, and Sentinel_Worker routines SHALL be suspended if and
// only if the current tier is SHIELD_PAUSED.

import type { SubscriptionTier } from "@kshema/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  canTransition,
  transitionTier,
  type SubscriptionEvent,
} from "./subscriptions.js";

/**
 * Validates: Requirements 20.1, 20.4, 20.5, 20.8, 21.19
 *
 * Property 10 asserts, over the full (tier x event) grid and over arbitrary
 * sequences of lifecycle events, that the pure guarded tier state machine
 * (`transitionTier` / `canTransition`) obeys exactly the four legal edges:
 *
 *   TRIAL          -> PRO            (PRO_PURCHASE)      R20.8
 *   TRIAL          -> SHIELD_PAUSED  (TRIAL_EXPIRY)      R20.4
 *   SHIELD_PAUSED  -> PRO            (PRO_PURCHASE)      R20.8
 *   SHIELD_PAUSED  -> TRIAL          (TRIAL_EXTENSION)   R21.19
 *
 * and rejects everything else (R20.1 lifecycle integrity), including every edge
 * out of the terminal PRO tier (R20.5 — a paid subscription is not silently
 * downgraded by these events).
 *
 * Sub-properties:
 *   (a) transitionTier accepts EXACTLY the four legal edges over the whole
 *       (tier x event) grid and rejects every other combination with ok:false.
 *   (b) Applying an arbitrary sequence of events, starting from any tier, only
 *       ever visits reachable tiers and never lands in an illegal state; the
 *       reached tier always equals an independent oracle's fold.
 *   (c) PRO is terminal w.r.t. these events — no event has a legal edge out of
 *       PRO.
 *   (d) The named requirement edges hold: SHIELD_PAUSED->TRIAL extension
 *       (R21.19), TRIAL->SHIELD_PAUSED expiry (R20.4), and *->PRO purchase from
 *       both non-PRO tiers (R20.8).
 */
describe("transitionTier — Property 10 (R20.1/R20.4/R20.5/R20.8/R21.19)", () => {
  const ALL_TIERS: readonly SubscriptionTier[] = [
    "TRIAL",
    "PRO",
    "SHIELD_PAUSED",
  ];
  const ALL_EVENTS: readonly SubscriptionEvent[] = [
    "PRO_PURCHASE",
    "TRIAL_EXPIRY",
    "TRIAL_EXTENSION",
  ];

  // Independent oracle: the four legal edges, expressed as a lookup keyed by
  // `${from}:${event}`. Anything not present here is illegal.
  const LEGAL_EDGES: ReadonlyMap<string, SubscriptionTier> = new Map([
    ["TRIAL:PRO_PURCHASE", "PRO"],
    ["TRIAL:TRIAL_EXPIRY", "SHIELD_PAUSED"],
    ["SHIELD_PAUSED:PRO_PURCHASE", "PRO"],
    ["SHIELD_PAUSED:TRIAL_EXTENSION", "TRIAL"],
  ]);

  const oracleTarget = (
    from: SubscriptionTier,
    event: SubscriptionEvent,
  ): SubscriptionTier | undefined => LEGAL_EDGES.get(`${from}:${event}`);

  const tierArb = fc.constantFrom(...ALL_TIERS);
  const eventArb = fc.constantFrom(...ALL_EVENTS);

  it("(a) accepts EXACTLY the four legal edges and rejects all others over the full grid", () => {
    fc.assert(
      fc.property(tierArb, eventArb, (from, event) => {
        const result = transitionTier(from, event);
        const expectedTo = oracleTarget(from, event);

        if (expectedTo !== undefined) {
          // Legal edge: ok:true, correct target, and echoes the inputs.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.to).toBe(expectedTo);
            expect(result.from).toBe(from);
            expect(result.event).toBe(event);
          }
          expect(canTransition(from, event)).toBe(true);
        } else {
          // Illegal edge: ok:false with a reason; canTransition agrees.
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.from).toBe(from);
            expect(result.event).toBe(event);
            expect(typeof result.reason).toBe("string");
            expect(result.reason.length).toBeGreaterThan(0);
          }
          expect(canTransition(from, event)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );

    // Exhaustive witness: exactly 4 of the 9 (tier x event) combinations are legal.
    let legalCount = 0;
    for (const from of ALL_TIERS) {
      for (const event of ALL_EVENTS) {
        if (canTransition(from, event)) legalCount += 1;
      }
    }
    expect(legalCount).toBe(4);
  });

  it("(b) any sequence of events only visits reachable tiers and matches the oracle fold", () => {
    fc.assert(
      fc.property(
        tierArb,
        fc.array(eventArb, { minLength: 0, maxLength: 20 }),
        (start, events) => {
          let current = start;
          for (const event of events) {
            const result = transitionTier(current, event);
            const expectedTo = oracleTarget(current, event);

            if (expectedTo !== undefined) {
              expect(result.ok).toBe(true);
              // A legal edge advances the tier; an illegal one is a no-op below.
              if (result.ok) current = result.to;
            } else {
              expect(result.ok).toBe(false);
              // Illegal event: tier is unchanged (caller must not advance).
            }

            // The machine never lands outside the three known tiers.
            expect(ALL_TIERS).toContain(current);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("(c) PRO is terminal — no event has a legal edge out of PRO", () => {
    fc.assert(
      fc.property(eventArb, (event) => {
        const result = transitionTier("PRO", event);
        expect(result.ok).toBe(false);
        expect(canTransition("PRO", event)).toBe(false);
      }),
      { numRuns: 100 },
    );

    // And once a sequence reaches PRO, it stays PRO regardless of later events.
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 20 }),
        (events) => {
          let current: SubscriptionTier = "PRO";
          for (const event of events) {
            const result = transitionTier(current, event);
            if (result.ok) current = result.to;
          }
          expect(current).toBe("PRO");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("(d) the named requirement edges hold (R21.19, R20.4, R20.8)", () => {
    // R21.19 — admin trial extension restores a lapsed Circle.
    const extension = transitionTier("SHIELD_PAUSED", "TRIAL_EXTENSION");
    expect(extension.ok).toBe(true);
    if (extension.ok) expect(extension.to).toBe("TRIAL");

    // R20.4 — trial window elapses -> Shield paused.
    const expiry = transitionTier("TRIAL", "TRIAL_EXPIRY");
    expect(expiry.ok).toBe(true);
    if (expiry.ok) expect(expiry.to).toBe("SHIELD_PAUSED");

    // R20.8 — a verified purchase upgrades to PRO from either non-PRO tier.
    fc.assert(
      fc.property(
        fc.constantFrom<SubscriptionTier>("TRIAL", "SHIELD_PAUSED"),
        (from) => {
          const purchase = transitionTier(from, "PRO_PURCHASE");
          expect(purchase.ok).toBe(true);
          if (purchase.ok) expect(purchase.to).toBe("PRO");
        },
      ),
      { numRuns: 100 },
    );
  });
});
