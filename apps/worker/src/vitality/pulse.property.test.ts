// Feature: kshema-safety-platform, Property 16: For all confirmed morning
// routines, the generated Vitality_Pulse SHALL include the Anchor preferred
// display name (falling back to "Anchor" when null/blank), the confirmation
// time expressed in the Anchor timezone, the echoed timezone, and the available
// context fields — for EACH Observer in the Circle, with exactly one
// Vitality_Pulse_Log recorded for the confirmed morning.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  emitVitalityPulse,
  renderConfirmationTime,
  type AnchorProfile,
  type ObserverRecipient,
  type VitalityContext,
  type VitalityPulse,
  type VitalityPulseDeps,
} from "./pulse.js";

/**
 * Validates: Requirements 7.2
 *
 * Property 16 asserts field completeness of every emitted Vitality_Pulse across
 * arbitrary Anchor profiles, Observer sets, confirmation instants, and context.
 * The generators intentionally straddle the preferred-name fallback boundary
 * (real names, `null`, and whitespace-only blanks) and draw the timezone from a
 * small set of valid IANA zones so the tz-rendered confirmation time varies.
 *
 * The oracle recomputes each required field independently of the module under
 * test: the expected display name from the fallback rule, and the expected
 * confirmation time from {@link renderConfirmationTime} for that instant +
 * timezone. It also asserts the fan-out invariant (exactly one pulse per
 * Observer, in order) and the single-log invariant (R7.5 backstop for R7.2).
 */
describe("vitality pulse — Property 16 (R7.2 field completeness)", () => {
  // A small set of valid IANA timezones spanning positive, zero, and negative
  // UTC offsets (and a DST-observing zone) so the rendered time genuinely
  // depends on the Anchor timezone rather than being incidentally UTC.
  const timezone = fc.constantFrom(
    "Asia/Kolkata",
    "UTC",
    "America/New_York",
    "Europe/London",
    "Australia/Sydney",
    "Pacific/Kiritimati",
  );

  // Preferred name straddles the fallback boundary: a real name, an explicit
  // null, and whitespace-only blanks (which must also fall back to "Anchor").
  const preferredName = fc.oneof(
    fc.string({ minLength: 1, maxLength: 24 }),
    fc.constant<string | null>(null),
    fc.constantFrom(" ", "   ", "\t", "\n  "),
  );

  const anchorArb: fc.Arbitrary<AnchorProfile> = fc.record({
    anchorId: fc.string({ minLength: 1, maxLength: 12 }),
    preferredName,
    timezone,
  });

  // Distinct Observer ids so the one-pulse-per-Observer mapping is checkable.
  const observersArb: fc.Arbitrary<ObserverRecipient[]> = fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: 0,
      maxLength: 8,
    })
    .map((ids) =>
      ids.map((observerId) => ({
        observerId,
        pushTokens: [],
      })),
    );

  const contextArb: fc.Arbitrary<VitalityContext> = fc.record(
    {
      steps: fc.integer({ min: 0, max: 50_000 }),
      weather: fc.string({ maxLength: 24 }),
    },
    { requiredKeys: [] },
  );

  // Confirmation instants across a wide, realistic epoch-millis range so the
  // tz rendering is exercised over many wall-clock times and DST boundaries.
  const confirmedAtMillis = fc.integer({
    min: Date.UTC(2020, 0, 1),
    max: Date.UTC(2030, 11, 31),
  });

  const scenarioArb = fc.record({
    circleId: fc.string({ minLength: 1, maxLength: 12 }),
    anchor: anchorArb,
    observers: observersArb,
    confirmedAtMillis,
    context: contextArb,
  });

  it("emits one fully-populated pulse per Observer and records exactly one log", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const delivered: VitalityPulse[] = [];
        const logs: Array<{
          circleId: string;
          anchorId: string;
          confirmedAtMillis: number;
          context: VitalityContext;
        }> = [];

        const deps: VitalityPulseDeps = {
          loadAnchorProfile: async () => scenario.anchor,
          listObservers: async () => scenario.observers,
          recordPulseLog: async (input) => {
            logs.push(input);
          },
          deliverPulse: async (pulse) => {
            delivered.push(pulse);
          },
        };

        const result = await emitVitalityPulse(deps, {
          circleId: scenario.circleId,
          anchorId: scenario.anchor.anchorId,
          confirmedAtMillis: scenario.confirmedAtMillis,
          context: scenario.context,
        });

        // Independent oracle for the required R7.2 fields.
        const trimmed = scenario.anchor.preferredName?.trim() ?? "";
        const expectedName = trimmed.length > 0 ? scenario.anchor.preferredName : "Anchor";
        const expectedTime = renderConfirmationTime(
          scenario.confirmedAtMillis,
          scenario.anchor.timezone,
        );

        // Fan-out invariant: exactly one pulse per Observer, in order (R7.1).
        expect(result.pulses).toHaveLength(scenario.observers.length);
        expect(delivered).toHaveLength(scenario.observers.length);
        expect(delivered.map((p) => p.observerId)).toEqual(
          scenario.observers.map((o) => o.observerId),
        );

        // Every emitted pulse carries ALL required R7.2 fields, populated.
        for (const pulse of delivered) {
          // Non-empty preferred display name with the null/blank fallback.
          expect(pulse.anchorPreferredName).toBe(expectedName);
          expect(pulse.anchorPreferredName.length).toBeGreaterThan(0);

          // Confirmation time rendered in the Anchor timezone.
          expect(pulse.confirmationTimeLocal).toBe(expectedTime);
          expect(pulse.confirmationTimeLocal).toMatch(/^\d{2}:\d{2}$/);

          // Timezone echoed back to clients.
          expect(pulse.timezone).toBe(scenario.anchor.timezone);

          // Raw instant preserved and context carried through verbatim.
          expect(pulse.confirmedAtMillis).toBe(scenario.confirmedAtMillis);
          expect(pulse.context).toEqual(scenario.context);

          // Identity fields wired to the confirmed morning.
          expect(pulse.circleId).toBe(scenario.circleId);
          expect(pulse.anchorId).toBe(scenario.anchor.anchorId);
        }

        // Single-log invariant: exactly one Vitality_Pulse_Log for the morning,
        // independent of Observer count (R7.5 backstop for the R7.2 event).
        expect(result.logged).toBe(true);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toEqual({
          circleId: scenario.circleId,
          anchorId: scenario.anchor.anchorId,
          confirmedAtMillis: scenario.confirmedAtMillis,
          context: scenario.context,
        });
      }),
      { numRuns: 200 },
    );
  });
});
