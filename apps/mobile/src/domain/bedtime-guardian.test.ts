/**
 * On-device Bedtime Battery Guardian tests (task 22.3): the pure evaluator
 * (R32.1, R32.2) matching the worker thresholds, and the runner's silent-skip
 * on an unavailable battery read.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  BEDTIME_CHIME_MESSAGE,
  BEDTIME_LOW_THRESHOLD,
  PRE_DAWN_EXHAUSTION_THRESHOLD,
  evaluateBedtimeGuardian,
  runBedtimeGuardian,
  type BatteryReader,
  type ChimePlayer,
} from "./bedtime-guardian.js";

describe("evaluateBedtimeGuardian (R32.1, R32.2)", () => {
  it("chimes iff BEDTIME_MINUS_60 & <25% & UNPLUGGED; pre-dawn iff POST_MIDNIGHT & <15% & UNPLUGGED", () => {
    fc.assert(
      fc.property(
        fc.record({
          batteryLevel: fc.integer({ min: 0, max: 100 }),
          chargerState: fc.constantFrom("PLUGGED" as const, "UNPLUGGED" as const),
          phase: fc.constantFrom("BEDTIME_MINUS_60" as const, "POST_MIDNIGHT" as const),
        }),
        ({ batteryLevel, chargerState, phase }) => {
          const decision = evaluateBedtimeGuardian({ phase, batteryLevel, chargerState });
          const unplugged = chargerState === "UNPLUGGED";
          const wantChime =
            phase === "BEDTIME_MINUS_60" && unplugged && batteryLevel < BEDTIME_LOW_THRESHOLD;
          const wantPreDawn =
            phase === "POST_MIDNIGHT" && unplugged && batteryLevel < PRE_DAWN_EXHAUSTION_THRESHOLD;

          if (wantChime) {
            expect(decision.action).toBe("bedtime_chime");
            expect(decision.chime).toBe(true);
          } else if (wantPreDawn) {
            expect(decision.action).toBe("pre_dawn_warning");
          } else {
            expect(decision.action).toBe("none");
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("thresholds are strict — exactly 25% / 15% do not trip", () => {
    expect(
      evaluateBedtimeGuardian({ phase: "BEDTIME_MINUS_60", batteryLevel: 25, chargerState: "UNPLUGGED" }).action,
    ).toBe("none");
    expect(
      evaluateBedtimeGuardian({ phase: "POST_MIDNIGHT", batteryLevel: 15, chargerState: "UNPLUGGED" }).action,
    ).toBe("none");
  });

  it("never acts when plugged in", () => {
    expect(
      evaluateBedtimeGuardian({ phase: "BEDTIME_MINUS_60", batteryLevel: 5, chargerState: "PLUGGED" }).action,
    ).toBe("none");
  });
});

describe("runBedtimeGuardian", () => {
  it("plays the chime message when the decision is bedtime_chime", async () => {
    const reader: BatteryReader = {
      read: async () => ({ batteryLevel: 10, chargerState: "UNPLUGGED" }),
    };
    const chime: ChimePlayer = { play: vi.fn(async () => {}) };
    const result = await runBedtimeGuardian({ reader, chime }, "BEDTIME_MINUS_60");
    expect(result.chimed).toBe(true);
    expect(chime.play).toHaveBeenCalledWith(BEDTIME_CHIME_MESSAGE);
  });

  it("skips silently (no chime) when the battery read is unavailable", async () => {
    const reader: BatteryReader = { read: async () => null };
    const chime: ChimePlayer = { play: vi.fn(async () => {}) };
    const result = await runBedtimeGuardian({ reader, chime }, "BEDTIME_MINUS_60");
    expect(result.skipped).toBe(true);
    expect(result.chimed).toBe(false);
    expect(chime.play).not.toHaveBeenCalled();
  });
});
