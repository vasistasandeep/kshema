// Feature: kshema-safety-platform, Property 12
//
// Property 12: Offline grace withholds heartbeat-only escalation (R24.4).
//
// *For all* devices offline within the configured network-grace window, no
// Safety_Incident SHALL open attributable solely to missing heartbeats until
// buffered telemetry is reconciled.
//
// This exercises `evaluateNetworkGrace` over arbitrary trigger sets and
// arbitrary offline states — `lastTelemetrySyncAt` at varying ages (well
// inside, exactly at, and outside the grace window), `pendingOfflineReconciliation`
// true/false — and arbitrary `now`. The core invariant is a biconditional:
// an escalation is withheld IFF it is heartbeat-silence-only AND the device is
// within the network-grace window. Corollaries checked below: a non-silence
// trigger is never withheld; outside the window with nothing pending admits.
//
// Validates: Requirements 24.4

import fc from "fast-check";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NETWORK_GRACE_WINDOW_MS,
  evaluateNetworkGrace,
  isHeartbeatSilenceOnly,
  isWithinNetworkGrace,
  type EscalationTrigger,
  type OfflineState,
} from "./network-grace.js";

const RUNS = 300;
const WINDOW = DEFAULT_NETWORK_GRACE_WINDOW_MS;

/** Non-silence triggers — real signals offline buffering cannot explain away. */
const NON_SILENCE: readonly EscalationTrigger[] = [
  "rhythm_with_other_signals",
  "acoustic_distress",
  "shadow_sos",
  "other",
];

/** Any recognized trigger, silence included. */
const anyTrigger: fc.Arbitrary<EscalationTrigger> = fc.constantFrom(
  "heartbeat_silence",
  ...NON_SILENCE,
);

/** Arbitrary trigger set (may be empty ⇒ bare grace-deadline miss). */
const triggerSet: fc.Arbitrary<readonly EscalationTrigger[]> = fc.array(
  anyTrigger,
  { maxLength: 5 },
);

/** A plausible "now" epoch-ms so relative offsets stay positive and realistic. */
const now: fc.Arbitrary<number> = fc.integer({
  min: Date.UTC(2025, 0, 1),
  max: Date.UTC(2027, 0, 1),
});

/**
 * Age (ms) of the last sync relative to `now`, deliberately spanning the
 * window edge: comfortably inside, exactly at the boundary, just outside, and
 * far outside — plus negative (future-dated / clock skew) which is in-grace.
 */
function syncAgeFor(now: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: WINDOW - 1 }) }, // inside
    { weight: 1, arbitrary: fc.constant(WINDOW) }, // exact boundary (inclusive)
    { weight: 1, arbitrary: fc.constant(WINDOW + 1) }, // just outside
    { weight: 2, arbitrary: fc.integer({ min: WINDOW + 1, max: WINDOW * 20 }) }, // far outside
    { weight: 1, arbitrary: fc.integer({ min: -WINDOW, max: -1 }) }, // future-dated
  );
}

/** Arbitrary offline state paired with the `now` it is relative to. */
const offlineState = (now: number): fc.Arbitrary<OfflineState> =>
  fc.record({
    lastTelemetrySyncAt: fc.oneof(
      syncAgeFor(now).map((age) => now - age),
      fc.constant(null),
      fc.constant(undefined),
    ),
    pendingOfflineReconciliation: fc.boolean(),
  });

describe("Property 12: offline grace withholds heartbeat-only escalation (R24.4)", () => {
  it("withholds IFF heartbeat-silence-only AND within the network-grace window", () => {
    fc.assert(
      fc.property(
        now.chain((n) =>
          fc.record({
            now: fc.constant(n),
            triggers: triggerSet,
            offline: offlineState(n),
          }),
        ),
        ({ now: n, triggers, offline }) => {
          const trigger = { triggers };
          const decision = evaluateNetworkGrace({ trigger, offline, now: n });

          const silenceOnly = isHeartbeatSilenceOnly(trigger);
          const inGrace = isWithinNetworkGrace(offline, n, WINDOW);

          // The biconditional at the heart of R24.4.
          expect(decision.withhold).toBe(silenceOnly && inGrace);

          // Reason stays consistent with the decision.
          if (decision.withhold) {
            expect(decision.reason).toBe(
              "withheld-heartbeat-silence-within-grace",
            );
          } else {
            expect(decision.reason).not.toBe(
              "withheld-heartbeat-silence-within-grace",
            );
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("NEVER withholds when a non-silence trigger is present, regardless of offline state", () => {
    fc.assert(
      fc.property(
        now.chain((n) =>
          fc.record({
            now: fc.constant(n),
            // At least one guaranteed non-silence trigger, mixed with any others.
            forced: fc.constantFrom(...NON_SILENCE),
            rest: triggerSet,
            offline: offlineState(n),
          }),
        ),
        ({ now: n, forced, rest, offline }) => {
          const trigger = { triggers: [forced, ...rest] };
          const decision = evaluateNetworkGrace({ trigger, offline, now: n });
          expect(decision.withhold).toBe(false);
          expect(decision.reason).toBe("admitted-non-silence-trigger");
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("admits heartbeat-silence-only outside the window with nothing pending", () => {
    fc.assert(
      fc.property(
        now.chain((n) =>
          fc.record({
            now: fc.constant(n),
            // Silence-only: heartbeat_silence or an empty set.
            triggers: fc.oneof(
              fc.constant<readonly EscalationTrigger[]>(["heartbeat_silence"]),
              fc.constant<readonly EscalationTrigger[]>([]),
            ),
            // Strictly outside the window, and no pending reconciliation.
            age: fc.integer({ min: WINDOW + 1, max: WINDOW * 50 }),
          }),
        ),
        ({ now: n, triggers, age }) => {
          const offline: OfflineState = {
            lastTelemetrySyncAt: n - age,
            pendingOfflineReconciliation: false,
          };
          const decision = evaluateNetworkGrace({
            trigger: { triggers },
            offline,
            now: n,
          });
          expect(decision.withhold).toBe(false);
          expect(decision.reason).toBe("admitted-reconciled");
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("withholds heartbeat-silence-only at exactly the window edge (inclusive boundary)", () => {
    fc.assert(
      fc.property(
        now,
        fc.oneof(
          fc.constant<readonly EscalationTrigger[]>(["heartbeat_silence"]),
          fc.constant<readonly EscalationTrigger[]>([]),
        ),
        (n, triggers) => {
          const offline: OfflineState = {
            // Elapsed === WINDOW ⇒ in-grace (elapsed <= windowMs).
            lastTelemetrySyncAt: n - WINDOW,
            pendingOfflineReconciliation: false,
          };
          const decision = evaluateNetworkGrace({
            trigger: { triggers },
            offline,
            now: n,
          });
          expect(decision.withhold).toBe(true);
          expect(decision.reason).toBe(
            "withheld-heartbeat-silence-within-grace",
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});
