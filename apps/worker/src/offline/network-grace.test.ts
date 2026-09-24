import { describe, expect, it } from "vitest";

import type { AggregatePersonaEvaluation } from "../personas/evaluators.js";
import {
  DEFAULT_NETWORK_GRACE_WINDOW_MS,
  createNetworkGraceGuard,
  evaluateNetworkGrace,
  isHeartbeatSilenceOnly,
  isWithinNetworkGrace,
  triggerContextFromEvaluation,
  type EscalationTrigger,
} from "./network-grace.js";

const NOW = Date.UTC(2025, 0, 31, 7, 30, 0);

describe("isHeartbeatSilenceOnly", () => {
  it("is true when the only trigger is heartbeat silence", () => {
    expect(isHeartbeatSilenceOnly({ triggers: ["heartbeat_silence"] })).toBe(true);
  });

  it("treats an empty trigger set as silence-only (grace-deadline miss, no corroboration)", () => {
    expect(isHeartbeatSilenceOnly({ triggers: [] })).toBe(true);
  });

  it("is false when any non-silence trigger is present", () => {
    const cases: EscalationTrigger[][] = [
      ["rhythm_with_other_signals"],
      ["acoustic_distress"],
      ["shadow_sos"],
      ["heartbeat_silence", "acoustic_distress"],
      ["heartbeat_silence", "shadow_sos"],
    ];
    for (const triggers of cases) {
      expect(isHeartbeatSilenceOnly({ triggers })).toBe(false);
    }
  });
});

describe("isWithinNetworkGrace", () => {
  it("is true when a recent sync falls inside the window", () => {
    const state = { lastTelemetrySyncAt: NOW - 5 * 60 * 1000 };
    expect(isWithinNetworkGrace(state, NOW)).toBe(true);
  });

  it("is false when the last sync is older than the window", () => {
    const state = { lastTelemetrySyncAt: NOW - (DEFAULT_NETWORK_GRACE_WINDOW_MS + 1) };
    expect(isWithinNetworkGrace(state, NOW)).toBe(false);
  });

  it("is true at the exact window boundary (inclusive)", () => {
    const state = { lastTelemetrySyncAt: NOW - DEFAULT_NETWORK_GRACE_WINDOW_MS };
    expect(isWithinNetworkGrace(state, NOW)).toBe(true);
  });

  it("is true whenever reconciliation is still pending, regardless of sync time", () => {
    const state = {
      lastTelemetrySyncAt: NOW - 10 * 60 * 60 * 1000,
      pendingOfflineReconciliation: true,
    };
    expect(isWithinNetworkGrace(state, NOW)).toBe(true);
  });

  it("is false when the device has never synced and nothing is pending", () => {
    expect(isWithinNetworkGrace({}, NOW)).toBe(false);
    expect(isWithinNetworkGrace({ lastTelemetrySyncAt: null }, NOW)).toBe(false);
  });
});

describe("evaluateNetworkGrace (R24.4)", () => {
  it("withholds a heartbeat-silence-only escalation within the grace window", () => {
    const decision = evaluateNetworkGrace({
      trigger: { triggers: ["heartbeat_silence"] },
      offline: { lastTelemetrySyncAt: NOW - 3 * 60 * 1000 },
      now: NOW,
    });
    expect(decision.withhold).toBe(true);
    expect(decision.reason).toBe("withheld-heartbeat-silence-within-grace");
  });

  it("withholds when reconciliation is pending even if the last sync is stale", () => {
    const decision = evaluateNetworkGrace({
      trigger: { triggers: [] },
      offline: {
        lastTelemetrySyncAt: NOW - 24 * 60 * 60 * 1000,
        pendingOfflineReconciliation: true,
      },
      now: NOW,
    });
    expect(decision.withhold).toBe(true);
  });

  it("admits after buffered telemetry reconciles (outside window, nothing pending)", () => {
    const decision = evaluateNetworkGrace({
      trigger: { triggers: ["heartbeat_silence"] },
      offline: {
        lastTelemetrySyncAt: NOW - (DEFAULT_NETWORK_GRACE_WINDOW_MS + 60_000),
        pendingOfflineReconciliation: false,
      },
      now: NOW,
    });
    expect(decision.withhold).toBe(false);
    expect(decision.reason).toBe("admitted-reconciled");
  });

  it("admits a heartbeat-silence escalation once outside the grace window", () => {
    const decision = evaluateNetworkGrace({
      trigger: { triggers: ["heartbeat_silence"] },
      offline: { lastTelemetrySyncAt: NOW - 60 * 60 * 1000 },
      now: NOW,
    });
    expect(decision.withhold).toBe(false);
  });

  it("never withholds a non-silence trigger, even within the grace window", () => {
    for (const trigger of [
      "acoustic_distress",
      "shadow_sos",
      "rhythm_with_other_signals",
    ] as const) {
      const decision = evaluateNetworkGrace({
        trigger: { triggers: [trigger] },
        offline: {
          lastTelemetrySyncAt: NOW - 60 * 1000,
          pendingOfflineReconciliation: true,
        },
        now: NOW,
      });
      expect(decision.withhold).toBe(false);
      expect(decision.reason).toBe("admitted-non-silence-trigger");
    }
  });

  it("does not withhold silence mixed with a real signal within grace", () => {
    const decision = evaluateNetworkGrace({
      trigger: { triggers: ["heartbeat_silence", "acoustic_distress"] },
      offline: { lastTelemetrySyncAt: NOW - 60 * 1000 },
      now: NOW,
    });
    expect(decision.withhold).toBe(false);
  });
});

describe("createNetworkGraceGuard", () => {
  it("returns true to withhold heartbeat-silence-only within the window", () => {
    const guard = createNetworkGraceGuard();
    expect(
      guard({
        trigger: { triggers: ["heartbeat_silence"] },
        offline: { lastTelemetrySyncAt: NOW - 60 * 1000 },
        now: NOW,
      }),
    ).toBe(true);
  });

  it("honors a custom, smaller grace window", () => {
    const guard = createNetworkGraceGuard(60 * 1000);
    // 2 minutes since sync is outside a 1-minute window ⇒ admit.
    expect(
      guard({
        trigger: { triggers: ["heartbeat_silence"] },
        offline: { lastTelemetrySyncAt: NOW - 2 * 60 * 1000 },
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("triggerContextFromEvaluation", () => {
  function evalWith(triggeredModes: AggregatePersonaEvaluation["triggeredModes"]): AggregatePersonaEvaluation {
    return { evaluations: [], escalate: triggeredModes.length > 0, triggeredModes };
  }

  it("maps a lone Elderly_Care rhythm miss to heartbeat_silence (withheld in grace)", () => {
    const ctx = triggerContextFromEvaluation(evalWith(["ELDERLY_CARE"]));
    expect(isHeartbeatSilenceOnly(ctx)).toBe(true);
  });

  it("maps other persona modes to a corroborated signal (never withheld)", () => {
    const ctx = triggerContextFromEvaluation(evalWith(["SOLO_LIVING"]));
    expect(isHeartbeatSilenceOnly(ctx)).toBe(false);
  });

  it("is silence-only when nothing triggered (bare grace-deadline miss)", () => {
    const ctx = triggerContextFromEvaluation(evalWith([]));
    expect(isHeartbeatSilenceOnly(ctx)).toBe(true);
  });
});
