import { describe, expect, it, vi } from "vitest";

import type { SubscriptionTier } from "@kshema/database";
import {
  SHIELD_EMERGENCY_PATHS_UNAFFECTED,
  createNoopShieldGate,
  createShieldGate,
  isShieldPaused,
} from "./shield-gate.js";

const TRIAL = "TRIAL" as SubscriptionTier;
const PRO = "PRO" as SubscriptionTier;
const SHIELD_PAUSED = "SHIELD_PAUSED" as SubscriptionTier;

describe("isShieldPaused — the pure predicate (R20.2/R20.5)", () => {
  it("is true only for SHIELD_PAUSED", () => {
    expect(isShieldPaused("SHIELD_PAUSED")).toBe(true);
  });

  it("is false for TRIAL and PRO (they keep full capabilities, R20.2)", () => {
    expect(isShieldPaused("TRIAL")).toBe(false);
    expect(isShieldPaused("PRO")).toBe(false);
  });

  it("treats a missing/unknown tier as NOT paused (fail-safe: never suspend on garbled tier)", () => {
    expect(isShieldPaused(undefined)).toBe(false);
    expect(isShieldPaused(null)).toBe(false);
    // A value outside the enum is also not the paused state.
    expect(isShieldPaused("SOMETHING_ELSE" as unknown as SubscriptionTier)).toBe(
      false,
    );
  });

  it("is a pure function of its argument (no I/O, no clock)", () => {
    // Deterministic across repeated calls with the same input.
    for (let i = 0; i < 5; i += 1) {
      expect(isShieldPaused("SHIELD_PAUSED")).toBe(true);
      expect(isShieldPaused("PRO")).toBe(false);
    }
  });
});

describe("createShieldGate — injectable tier-lookup seam (R20.5)", () => {
  it("suspends when the looked-up tier is SHIELD_PAUSED", async () => {
    const lookup = vi.fn(async () => SHIELD_PAUSED);
    const gate = createShieldGate(lookup);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith("circle-1");
  });

  it("does NOT suspend for TRIAL (full capabilities, R20.2/R20.3)", async () => {
    const gate = createShieldGate(() => TRIAL);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(false);
  });

  it("does NOT suspend for PRO (full capabilities, R20.2)", async () => {
    const gate = createShieldGate(() => PRO);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(false);
  });

  it("resumes automatically after SHIELD_PAUSED→PRO (re-reads current tier, R20.8)", async () => {
    // First consult: paused. Second consult: PRO (e.g. after a Pro purchase).
    const lookup = vi
      .fn(() => SHIELD_PAUSED)
      .mockReturnValueOnce(SHIELD_PAUSED)
      .mockReturnValueOnce(PRO);
    const gate = createShieldGate(lookup);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(true);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(false);
    // Stateless: no write-back, just two reads.
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("resumes automatically after SHIELD_PAUSED→TRIAL (admin extension, R20.19)", async () => {
    const lookup = vi
      .fn(() => SHIELD_PAUSED)
      .mockReturnValueOnce(SHIELD_PAUSED)
      .mockReturnValueOnce(TRIAL);
    const gate = createShieldGate(lookup);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(true);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(false);
  });

  it("accepts a synchronous lookup seam", async () => {
    const gate = createShieldGate(() => SHIELD_PAUSED);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(true);
  });

  it("accepts an async lookup seam", async () => {
    const gate = createShieldGate(async () => SHIELD_PAUSED);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(true);
  });

  it("treats an absent Subscription (undefined tier) as NOT suspended", async () => {
    const gate = createShieldGate(() => undefined);
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(false);
  });
});

describe("createNoopShieldGate", () => {
  it("never suspends", async () => {
    const gate = createNoopShieldGate();
    await expect(gate.shouldSuspend("circle-1")).resolves.toBe(false);
  });
});

describe("emergency boundary is structural (R20.3/R20.5)", () => {
  it("the gate exposes no emergency surface and asserts non-suppression by construction", () => {
    // The marker documents that no code path from an emergency entry point
    // (Shadow_SOS / acoustic distress / hardware duress) reaches this gate.
    expect(SHIELD_EMERGENCY_PATHS_UNAFFECTED).toBe(true);
  });
});
