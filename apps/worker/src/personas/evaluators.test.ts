import { describe, expect, it } from "vitest";

import {
  DEFAULT_PERSONA_MODE,
  PERSONA_MODES,
  evaluateActiveSession,
  evaluateElderlyCare,
  evaluateJourneyWatch,
  evaluatePersonaModes,
  evaluatePostOpRecovery,
  evaluateSoloLiving,
  resolveActiveModes,
  type ElderlyCareInput,
} from "./evaluators.js";

// Base Elderly_Care input: mean 420 (07:00), stdDev 0 => deadline 420, no offsets.
function elderlyInput(overrides: Partial<ElderlyCareInput> = {}): ElderlyCareInput {
  return {
    mean: 420,
    stdDev: 0,
    isWeekend: false,
    priorDaySteps: 0,
    avgStep30d: 0,
    nowMinuteOfDay: 400,
    routineConfirmed: false,
    ...overrides,
  };
}

describe("resolveActiveModes (R3.2 default)", () => {
  it("defaults to Elderly_Care when none selected", () => {
    expect(resolveActiveModes(undefined)).toEqual([DEFAULT_PERSONA_MODE]);
    expect(resolveActiveModes([])).toEqual(["ELDERLY_CARE"]);
    expect(resolveActiveModes(null)).toEqual(["ELDERLY_CARE"]);
  });

  it("dedups and orders by canonical persona order", () => {
    expect(
      resolveActiveModes(["JOURNEY_WATCH", "ELDERLY_CARE", "JOURNEY_WATCH"]),
    ).toEqual(["ELDERLY_CARE", "JOURNEY_WATCH"]);
  });

  it("Elderly_Care is the declared default and part of all modes", () => {
    expect(DEFAULT_PERSONA_MODE).toBe("ELDERLY_CARE");
    expect(PERSONA_MODES).toContain("ELDERLY_CARE");
  });
});

describe("evaluateElderlyCare (R3.4) boundary", () => {
  it("does not trigger before the Grace_Deadline", () => {
    expect(evaluateElderlyCare(elderlyInput({ nowMinuteOfDay: 419 })).triggered).toBe(
      false,
    );
  });

  it("triggers exactly at the deadline (>=)", () => {
    expect(evaluateElderlyCare(elderlyInput({ nowMinuteOfDay: 420 })).triggered).toBe(
      true,
    );
  });

  it("triggers after the deadline", () => {
    expect(evaluateElderlyCare(elderlyInput({ nowMinuteOfDay: 500 })).triggered).toBe(
      true,
    );
  });

  it("never triggers when the routine is confirmed (R5.6/R6.5)", () => {
    expect(
      evaluateElderlyCare(
        elderlyInput({ nowMinuteOfDay: 900, routineConfirmed: true }),
      ).triggered,
    ).toBe(false);
  });

  it("weekend offset pushes the deadline out by 45m", () => {
    // deadline becomes 420 + 45 = 465; now=440 no longer past deadline.
    expect(
      evaluateElderlyCare(elderlyInput({ isWeekend: true, nowMinuteOfDay: 440 }))
        .triggered,
    ).toBe(false);
    expect(
      evaluateElderlyCare(elderlyInput({ isWeekend: true, nowMinuteOfDay: 465 }))
        .triggered,
    ).toBe(true);
  });
});

describe("evaluateSoloLiving (R3.5) boundary", () => {
  it("does not trigger at exactly the window (strict >)", () => {
    expect(
      evaluateSoloLiving({
        minutesSinceLastActivity: 240,
        inactivityWindowMin: 240,
      }).triggered,
    ).toBe(false);
  });

  it("triggers once the window is exceeded", () => {
    expect(
      evaluateSoloLiving({
        minutesSinceLastActivity: 241,
        inactivityWindowMin: 240,
      }).triggered,
    ).toBe(true);
  });
});

describe("evaluateActiveSession (R3.6) boundary", () => {
  it("never triggers outside an active session", () => {
    expect(
      evaluateActiveSession({
        sessionActive: false,
        immobileMinutes: 999,
        immobilityThresholdMin: 10,
      }).triggered,
    ).toBe(false);
  });

  it("does not trigger at the threshold (strict >)", () => {
    expect(
      evaluateActiveSession({
        sessionActive: true,
        immobileMinutes: 10,
        immobilityThresholdMin: 10,
      }).triggered,
    ).toBe(false);
  });

  it("triggers on immobility exceeding threshold during a session", () => {
    expect(
      evaluateActiveSession({
        sessionActive: true,
        immobileMinutes: 11,
        immobilityThresholdMin: 10,
      }).triggered,
    ).toBe(true);
  });
});

describe("evaluateJourneyWatch (R3.7) boundary", () => {
  it("does not trigger before the transit deadline", () => {
    expect(
      evaluateJourneyWatch({ now: 999, transitDeadline: 1000, arrived: false })
        .triggered,
    ).toBe(false);
  });

  it("triggers at/after the transit deadline when not arrived", () => {
    expect(
      evaluateJourneyWatch({ now: 1000, transitDeadline: 1000, arrived: false })
        .triggered,
    ).toBe(true);
  });

  it("never triggers once arrival is confirmed", () => {
    expect(
      evaluateJourneyWatch({ now: 5000, transitDeadline: 1000, arrived: true })
        .triggered,
    ).toBe(false);
  });
});

describe("evaluatePostOpRecovery (R3.8) boundary", () => {
  it("never triggers outside daytime", () => {
    expect(
      evaluatePostOpRecovery({
        isDaytime: false,
        daytimeInactiveMinutes: 999,
        recoveryThresholdMin: 60,
      }).triggered,
    ).toBe(false);
  });

  it("does not trigger at the threshold (strict >)", () => {
    expect(
      evaluatePostOpRecovery({
        isDaytime: true,
        daytimeInactiveMinutes: 60,
        recoveryThresholdMin: 60,
      }).triggered,
    ).toBe(false);
  });

  it("triggers on daytime inactivity exceeding threshold", () => {
    expect(
      evaluatePostOpRecovery({
        isDaytime: true,
        daytimeInactiveMinutes: 61,
        recoveryThresholdMin: 60,
      }).triggered,
    ).toBe(true);
  });
});

describe("evaluatePersonaModes — concurrent-mode aggregation (R3.9)", () => {
  it("defaults to Elderly_Care when no modes are enabled", () => {
    const result = evaluatePersonaModes(undefined, {
      ELDERLY_CARE: elderlyInput({ nowMinuteOfDay: 500 }),
    });
    expect(result.evaluations.map((e) => e.mode)).toEqual(["ELDERLY_CARE"]);
    expect(result.escalate).toBe(true);
    expect(result.triggeredModes).toEqual(["ELDERLY_CARE"]);
  });

  it("escalates when ANY enabled mode triggers", () => {
    const result = evaluatePersonaModes(["ELDERLY_CARE", "SOLO_LIVING"], {
      ELDERLY_CARE: elderlyInput({ nowMinuteOfDay: 400 }), // within deadline, no trigger
      SOLO_LIVING: {
        minutesSinceLastActivity: 500,
        inactivityWindowMin: 240,
      }, // triggers
    });
    expect(result.escalate).toBe(true);
    expect(result.triggeredModes).toEqual(["SOLO_LIVING"]);
  });

  it("does not escalate when all enabled modes withhold", () => {
    const result = evaluatePersonaModes(["ELDERLY_CARE", "ACTIVE_SESSION"], {
      ELDERLY_CARE: elderlyInput({ nowMinuteOfDay: 400 }),
      ACTIVE_SESSION: {
        sessionActive: true,
        immobileMinutes: 5,
        immobilityThresholdMin: 10,
      },
    });
    expect(result.escalate).toBe(false);
    expect(result.triggeredModes).toEqual([]);
    expect(result.evaluations).toHaveLength(2);
  });

  it("escalates when multiple modes trigger and lists all of them", () => {
    const result = evaluatePersonaModes(
      ["ELDERLY_CARE", "SOLO_LIVING", "JOURNEY_WATCH"],
      {
        ELDERLY_CARE: elderlyInput({ nowMinuteOfDay: 900 }), // triggers
        SOLO_LIVING: { minutesSinceLastActivity: 500, inactivityWindowMin: 60 }, // triggers
        JOURNEY_WATCH: { now: 100, transitDeadline: 200, arrived: false }, // within deadline
      },
    );
    expect(result.escalate).toBe(true);
    expect(result.triggeredModes).toEqual(["ELDERLY_CARE", "SOLO_LIVING"]);
  });

  it("skips enabled modes that lack inputs (no silent escalation)", () => {
    const result = evaluatePersonaModes(["ELDERLY_CARE", "JOURNEY_WATCH"], {
      ELDERLY_CARE: elderlyInput({ nowMinuteOfDay: 400 }),
      // JOURNEY_WATCH enabled but no inputs supplied
    });
    expect(result.evaluations.map((e) => e.mode)).toEqual(["ELDERLY_CARE"]);
    expect(result.escalate).toBe(false);
  });
});
