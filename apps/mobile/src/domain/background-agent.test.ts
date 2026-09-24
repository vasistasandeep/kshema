import { describe, expect, it } from "vitest";
import {
  captureDeviceConfig,
  hasLostBackgroundExecution,
  isAggressiveBatteryOem,
  planBatteryOnboarding,
  planLostExecutionNotification,
  type DeviceBackgroundState,
} from "./background-agent.js";

const android = (
  overrides: Partial<DeviceBackgroundState> = {},
): DeviceBackgroundState => ({
  platform: "ANDROID",
  oem: "Google",
  batteryExempt: false,
  foregroundServiceActive: true,
  ...overrides,
});

const ios = (
  overrides: Partial<DeviceBackgroundState> = {},
): DeviceBackgroundState => ({
  platform: "IOS",
  oem: "Apple",
  batteryExempt: true,
  foregroundServiceActive: false,
  ...overrides,
});

describe("aggressive-battery OEM detection (R18.2)", () => {
  it("matches known aggressive OEMs case-insensitively", () => {
    expect(isAggressiveBatteryOem("Xiaomi")).toBe(true);
    expect(isAggressiveBatteryOem("  OnePlus  ")).toBe(true);
    expect(isAggressiveBatteryOem("samsung")).toBe(true);
    expect(isAggressiveBatteryOem("Google")).toBe(false);
    expect(isAggressiveBatteryOem(null)).toBe(false);
    expect(isAggressiveBatteryOem(undefined)).toBe(false);
  });
});

describe("battery-optimization onboarding (R18.2)", () => {
  it("requests exemption on Android until granted", () => {
    expect(planBatteryOnboarding(android({ batteryExempt: false }))).toEqual({
      kind: "REQUEST_BATTERY_EXEMPTION",
      insistent: false,
    });
    expect(planBatteryOnboarding(android({ batteryExempt: true }))).toEqual({
      kind: "NONE",
    });
  });

  it("is insistent on aggressive OEMs", () => {
    expect(planBatteryOnboarding(android({ oem: "Xiaomi" }))).toEqual({
      kind: "REQUEST_BATTERY_EXEMPTION",
      insistent: true,
    });
  });

  it("never prompts on iOS", () => {
    expect(planBatteryOnboarding(ios())).toEqual({ kind: "NONE" });
    expect(planBatteryOnboarding(ios({ batteryExempt: false }))).toEqual({
      kind: "NONE",
    });
  });
});

describe("lost-background-execution detection + notification (R18.1, R18.4)", () => {
  it("flags loss on Android when the foreground service is down while protected", () => {
    expect(
      hasLostBackgroundExecution(
        android({ foregroundServiceActive: false }),
        true,
      ),
    ).toBe(true);
  });

  it("does not flag loss when protection is disabled", () => {
    expect(
      hasLostBackgroundExecution(
        android({ foregroundServiceActive: false }),
        false,
      ),
    ).toBe(false);
  });

  it("does not flag loss while the foreground service is running", () => {
    expect(
      hasLostBackgroundExecution(android({ foregroundServiceActive: true }), true),
    ).toBe(false);
  });

  it("does not treat iOS background tasks as a hard loss", () => {
    expect(hasLostBackgroundExecution(ios(), true)).toBe(false);
  });

  it("builds the restore notification suggesting the battery exemption", () => {
    expect(
      planLostExecutionNotification(
        android({ foregroundServiceActive: false, batteryExempt: false }),
        true,
      ),
    ).toEqual({
      kind: "RESTORE_AMBIENT_PROTECTION",
      suggestBatteryExemption: true,
    });
    expect(
      planLostExecutionNotification(
        android({ foregroundServiceActive: false, batteryExempt: true }),
        true,
      ),
    ).toEqual({
      kind: "RESTORE_AMBIENT_PROTECTION",
      suggestBatteryExemption: false,
    });
    expect(
      planLostExecutionNotification(android({ foregroundServiceActive: true }), true),
    ).toBeNull();
  });
});

describe("DeviceConfig capture (R18.5)", () => {
  it("captures the background-execution config, mirroring the Prisma model", () => {
    expect(
      captureDeviceConfig(
        android({ oem: "Samsung", batteryExempt: true }),
        "2025-01-01T06:00:00.000Z",
      ),
    ).toEqual({
      platform: "ANDROID",
      oem: "Samsung",
      batteryExempt: true,
      foregroundServiceActive: true,
      lastTelemetrySyncAt: "2025-01-01T06:00:00.000Z",
    });
  });

  it("normalizes a missing OEM to null and omits an unknown sync time", () => {
    const snap = captureDeviceConfig(android({ oem: null }));
    expect(snap.oem).toBeNull();
    expect(snap.lastTelemetrySyncAt).toBeUndefined();
  });
});
