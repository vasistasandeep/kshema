import { describe, expect, it, vi } from "vitest";

import {
  buildPulseForObserver,
  emitVitalityPulse,
  renderConfirmationTime,
  type AnchorProfile,
  type ObserverRecipient,
  type VitalityPulse,
  type VitalityPulseDeps,
} from "./pulse.js";

const CONFIRMED_AT = Date.UTC(2025, 0, 31, 1, 15, 0); // 06:45 IST

function makeDeps(overrides?: {
  anchor?: AnchorProfile;
  observers?: ObserverRecipient[];
}) {
  const anchor: AnchorProfile = overrides?.anchor ?? {
    anchorId: "anchor-1",
    preferredName: "Amma",
    timezone: "Asia/Kolkata",
  };
  const observers: ObserverRecipient[] = overrides?.observers ?? [
    { observerId: "obs-1", pushTokens: ["t1"] },
    { observerId: "obs-2", pushTokens: ["t2", "t3"] },
  ];
  const delivered: VitalityPulse[] = [];
  const logs: unknown[] = [];
  const deps: VitalityPulseDeps = {
    loadAnchorProfile: vi.fn(async () => anchor),
    listObservers: vi.fn(async () => observers),
    recordPulseLog: vi.fn(async (input) => {
      logs.push(input);
    }),
    deliverPulse: vi.fn(async (pulse) => {
      delivered.push(pulse);
    }),
  };
  return { deps, delivered, logs, anchor, observers };
}

describe("renderConfirmationTime (R7.2 — Anchor timezone)", () => {
  it("renders the confirmation time in the Anchor timezone", () => {
    expect(renderConfirmationTime(CONFIRMED_AT, "Asia/Kolkata")).toBe("06:45");
    expect(renderConfirmationTime(CONFIRMED_AT, "UTC")).toBe("01:15");
  });
});

describe("buildPulseForObserver (R7.2 field completeness)", () => {
  it("includes preferred name, tz-rendered time, timezone, and context", () => {
    const pulse = buildPulseForObserver({
      circleId: "circle-1",
      anchor: { anchorId: "anchor-1", preferredName: "Amma", timezone: "Asia/Kolkata" },
      observer: { observerId: "obs-1", pushTokens: ["t1"] },
      confirmedAtMillis: CONFIRMED_AT,
      context: { steps: 320, weather: "24C, clear" },
    });
    expect(pulse.anchorPreferredName).toBe("Amma");
    expect(pulse.confirmationTimeLocal).toBe("06:45");
    expect(pulse.timezone).toBe("Asia/Kolkata");
    expect(pulse.context).toEqual({ steps: 320, weather: "24C, clear" });
    expect(pulse.observerId).toBe("obs-1");
  });

  it("falls back to 'Anchor' when no preferred name is set", () => {
    const pulse = buildPulseForObserver({
      circleId: "circle-1",
      anchor: { anchorId: "anchor-1", preferredName: null, timezone: "UTC" },
      observer: { observerId: "obs-1", pushTokens: [] },
      confirmedAtMillis: CONFIRMED_AT,
      context: {},
    });
    expect(pulse.anchorPreferredName).toBe("Anchor");
  });
});

describe("emitVitalityPulse (R7.1/R7.2/R7.5)", () => {
  it("emits one pulse per Observer, each with name + tz time + context", async () => {
    const { deps, delivered } = makeDeps();
    const result = await emitVitalityPulse(deps, {
      circleId: "circle-1",
      anchorId: "anchor-1",
      confirmedAtMillis: CONFIRMED_AT,
      context: { steps: 500, weather: "28C" },
    });

    expect(result.pulses).toHaveLength(2);
    expect(delivered).toHaveLength(2);
    expect(delivered.map((p) => p.observerId)).toEqual(["obs-1", "obs-2"]);
    for (const pulse of delivered) {
      expect(pulse.anchorPreferredName).toBe("Amma");
      expect(pulse.confirmationTimeLocal).toBe("06:45");
      expect(pulse.timezone).toBe("Asia/Kolkata");
      expect(pulse.context).toEqual({ steps: 500, weather: "28C" });
    }
  });

  it("records exactly one VitalityPulseLog for the confirmed morning (R7.5)", async () => {
    const { deps, logs } = makeDeps();
    const result = await emitVitalityPulse(deps, {
      circleId: "circle-1",
      anchorId: "anchor-1",
      confirmedAtMillis: CONFIRMED_AT,
      context: { steps: 500 },
    });
    expect(result.logged).toBe(true);
    expect(deps.recordPulseLog).toHaveBeenCalledTimes(1);
    expect(logs[0]).toEqual({
      circleId: "circle-1",
      anchorId: "anchor-1",
      confirmedAtMillis: CONFIRMED_AT,
      context: { steps: 500 },
    });
  });

  it("still records the log with zero Observers (no pulses delivered)", async () => {
    const { deps, delivered } = makeDeps({ observers: [] });
    const result = await emitVitalityPulse(deps, {
      circleId: "circle-1",
      anchorId: "anchor-1",
      confirmedAtMillis: CONFIRMED_AT,
    });
    expect(result.pulses).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(deps.recordPulseLog).toHaveBeenCalledTimes(1);
  });
});
