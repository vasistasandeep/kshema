import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildHeartbeat,
  buildHomeWifiGhostSignal,
  detectMediaDeviceWakeSignals,
  HOME_WIFI_REASSOCIATION_MIN_HOUR,
  isStandbyToActiveTransition,
  qualifiesAsHomeWifiGhostSignal,
  type DiscoveredMediaDevice,
} from "./signals.js";

describe("buildHeartbeat passive-signal aggregation (R5.1, R5.2)", () => {
  it("maps readings into a heartbeat and stamps capturedAt", () => {
    const hb = buildHeartbeat(
      "dev-1",
      {
        screenUnlocks: ["2025-01-01T05:30:00.000Z"],
        stepDelta: 42,
        battery: 73,
        chargerState: "UNPLUGGED",
      },
      "2025-01-01T05:31:00.000Z",
    );
    expect(hb).toEqual({
      deviceId: "dev-1",
      screenUnlocks: ["2025-01-01T05:30:00.000Z"],
      stepDelta: 42,
      battery: 73,
      chargerState: "UNPLUGGED",
      capturedAt: "2025-01-01T05:31:00.000Z",
    });
  });

  it("normalizes a negative/missing step delta to 0 and clamps battery", () => {
    const hb = buildHeartbeat("dev-1", { stepDelta: -5, battery: 140 }, "t");
    expect(hb.stepDelta).toBe(0);
    expect(hb.battery).toBe(100);
    expect(hb.screenUnlocks).toEqual([]);
    expect(hb.chargerState).toBeUndefined();
  });

  it("carries no location field by construction (R5.5, R19.1)", () => {
    const hb = buildHeartbeat("dev-1", { stepDelta: 1 }, "t") as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(hb)) {
      expect(key.toLowerCase()).not.toContain("location");
      expect(key.toLowerCase()).not.toContain("gps");
      expect(key.toLowerCase()).not.toContain("lat");
      expect(key.toLowerCase()).not.toContain("lng");
    }
  });
});

describe("media-device wake ghost signals (R6.1, R6.2)", () => {
  const tv = (
    id: string,
    powerState: DiscoveredMediaDevice["powerState"],
  ): DiscoveredMediaDevice => ({ id, kind: "TIZEN_TV", powerState });

  it("emits a MEDIA_DEVICE_WAKE only on standby->active transitions", () => {
    const prev = [tv("a", "STANDBY"), tv("b", "ACTIVE")];
    const curr = [tv("a", "ACTIVE"), tv("b", "ACTIVE"), tv("c", "ACTIVE")];
    const signals = detectMediaDeviceWakeSignals(prev, curr, "t");
    // 'a' woke (STANDBY->ACTIVE); 'b' stayed ACTIVE; 'c' newly seen ACTIVE.
    const sources = signals.map((s) => s.source);
    expect(signals.every((s) => s.signalType === "MEDIA_DEVICE_WAKE")).toBe(true);
    expect(sources).toContain("TIZEN_TV:a");
    expect(sources).toContain("TIZEN_TV:c");
    expect(sources).not.toContain("TIZEN_TV:b");
  });

  it("classifies transitions", () => {
    expect(isStandbyToActiveTransition("STANDBY", "ACTIVE")).toBe(true);
    expect(isStandbyToActiveTransition(undefined, "ACTIVE")).toBe(true);
    expect(isStandbyToActiveTransition("ACTIVE", "ACTIVE")).toBe(false);
    expect(isStandbyToActiveTransition("STANDBY", "STANDBY")).toBe(false);
  });
});

describe("home-Wi-Fi re-association ghost signal, post-5AM gate (R6.3)", () => {
  it("qualifies only for the home network at or after 05:00 local", () => {
    expect(qualifiesAsHomeWifiGhostSignal({ isHomeNetwork: true, localHour: 5 })).toBe(true);
    expect(qualifiesAsHomeWifiGhostSignal({ isHomeNetwork: true, localHour: 8 })).toBe(true);
    expect(qualifiesAsHomeWifiGhostSignal({ isHomeNetwork: true, localHour: 4 })).toBe(false);
    expect(qualifiesAsHomeWifiGhostSignal({ isHomeNetwork: false, localHour: 9 })).toBe(false);
  });

  it("builds the ghost signal when qualifying and null otherwise", () => {
    expect(
      buildHomeWifiGhostSignal({
        isHomeNetwork: true,
        localHour: 6,
        detectedAt: "t",
        ssid: "HomeNet",
      }),
    ).toEqual({ signalType: "HOME_WIFI_REASSOCIATION", detectedAt: "t", source: "HomeNet" });
    expect(
      buildHomeWifiGhostSignal({ isHomeNetwork: true, localHour: 3, detectedAt: "t" }),
    ).toBeNull();
  });

  // Feature: kshema-safety-platform, Property: post-5AM home-Wi-Fi gating
  it("only ever produces a signal for home network at hour >= 5 (property)", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 23 }),
        (isHomeNetwork, localHour) => {
          const signal = buildHomeWifiGhostSignal({
            isHomeNetwork,
            localHour,
            detectedAt: "t",
          });
          const shouldQualify =
            isHomeNetwork && localHour >= HOME_WIFI_REASSOCIATION_MIN_HOUR;
          expect(signal !== null).toBe(shouldQualify);
        },
      ),
      { numRuns: 100 },
    );
  });
});
