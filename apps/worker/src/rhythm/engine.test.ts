import { describe, expect, it } from "vitest";

import {
  DEFAULT_FATIGUE_OFFSET_MIN,
  DEFAULT_WEEKEND_OFFSET_MIN,
  MINUTES_PER_DAY,
  ROLLING_WINDOW_DAYS,
  computeBaseline,
  computeGraceDeadline,
  updateProfileOnWakeEvent,
} from "./engine.js";

describe("computeBaseline (R4.1, R4.2, R4.7)", () => {
  it("returns a zero baseline for an empty sample set", () => {
    expect(computeBaseline([])).toEqual({ mean: 0, stdDev: 0, sampleCount: 0 });
  });

  it("returns mean=sample and stdDev=0 for a single sample", () => {
    expect(computeBaseline([420])).toEqual({
      mean: 420,
      stdDev: 0,
      sampleCount: 1,
    });
  });

  it("computes population mean and stdDev for a partial (<14) window", () => {
    // samples: 400, 440 -> mean 420, deviations ±20 -> stdDev 20
    const b = computeBaseline([400, 440]);
    expect(b.mean).toBe(420);
    expect(b.stdDev).toBe(20);
    expect(b.sampleCount).toBe(2);
  });

  it("uses only the most recent 14 samples when more are supplied", () => {
    // 15 samples: a leading outlier (0) that must be evicted, then 14 x 400.
    const samples = [0, ...Array.from({ length: 14 }, () => 400)];
    const b = computeBaseline(samples);
    expect(b.sampleCount).toBe(ROLLING_WINDOW_DAYS);
    expect(b.mean).toBe(400);
    expect(b.stdDev).toBe(0);
  });

  it("computes a full 14-day window baseline", () => {
    // 7 x 390 and 7 x 410 -> mean 400, each deviation ±10 -> stdDev 10.
    const samples = [
      ...Array.from({ length: 7 }, () => 390),
      ...Array.from({ length: 7 }, () => 410),
    ];
    const b = computeBaseline(samples);
    expect(b.sampleCount).toBe(14);
    expect(b.mean).toBe(400);
    expect(b.stdDev).toBe(10);
  });
});

describe("computeGraceDeadline (R4.3–R4.6)", () => {
  const noStepFatigue = { priorDaySteps: 0, avgStep30d: 1000 };

  it("is mean + 2*stdDev on a weekday with no fatigue (R4.3)", () => {
    const r = computeGraceDeadline({
      mean: 420,
      stdDev: 15,
      isWeekend: false,
      ...noStepFatigue,
    });
    expect(r.rawMinuteOfDay).toBe(450); // 420 + 30
    expect(r.minuteOfDay).toBe(450);
    expect(r.appliedWeekendOffsetMin).toBe(0);
    expect(r.appliedFatigueOffsetMin).toBe(0);
    expect(r.wrapsPastMidnight).toBe(false);
  });

  it("adds the 45-minute weekend offset on Sat/Sun (R4.4)", () => {
    const r = computeGraceDeadline({
      mean: 420,
      stdDev: 15,
      isWeekend: true,
      ...noStepFatigue,
    });
    expect(r.appliedWeekendOffsetMin).toBe(DEFAULT_WEEKEND_OFFSET_MIN);
    expect(r.rawMinuteOfDay).toBe(495); // 420 + 30 + 45
  });

  it("adds the 30-minute fatigue offset when prior steps exceed 180% (R4.5)", () => {
    const r = computeGraceDeadline({
      mean: 420,
      stdDev: 15,
      isWeekend: false,
      priorDaySteps: 1801, // > 1.8 * 1000
      avgStep30d: 1000,
    });
    expect(r.appliedFatigueOffsetMin).toBe(DEFAULT_FATIGUE_OFFSET_MIN);
    expect(r.rawMinuteOfDay).toBe(480); // 420 + 30 + 30
  });

  it("does NOT add the fatigue offset exactly at the 180% threshold (strict >)", () => {
    const r = computeGraceDeadline({
      mean: 420,
      stdDev: 15,
      isWeekend: false,
      priorDaySteps: 1800, // == 1.8 * 1000, not exceeding
      avgStep30d: 1000,
    });
    expect(r.appliedFatigueOffsetMin).toBe(0);
  });

  it("applies BOTH weekend and fatigue offsets together", () => {
    const r = computeGraceDeadline({
      mean: 420,
      stdDev: 15,
      isWeekend: true,
      priorDaySteps: 5000,
      avgStep30d: 1000,
    });
    // 420 + 30 + 45 + 30 = 525
    expect(r.rawMinuteOfDay).toBe(525);
    expect(r.appliedWeekendOffsetMin).toBe(DEFAULT_WEEKEND_OFFSET_MIN);
    expect(r.appliedFatigueOffsetMin).toBe(DEFAULT_FATIGUE_OFFSET_MIN);
  });

  it("honors custom offset overrides", () => {
    const r = computeGraceDeadline({
      mean: 100,
      stdDev: 0,
      isWeekend: true,
      priorDaySteps: 5000,
      avgStep30d: 1000,
      weekendOffsetMin: 60,
      fatigueOffsetMin: 15,
    });
    expect(r.rawMinuteOfDay).toBe(175); // 100 + 0 + 60 + 15
  });

  it("wraps a past-midnight deadline into a clock minute-of-day", () => {
    const r = computeGraceDeadline({
      mean: 1400,
      stdDev: 20, // base = 1440
      isWeekend: true, // +45
      priorDaySteps: 5000,
      avgStep30d: 1000, // +30 -> raw = 1515
    });
    expect(r.rawMinuteOfDay).toBe(1515);
    expect(r.wrapsPastMidnight).toBe(true);
    expect(r.minuteOfDay).toBe(1515 - MINUTES_PER_DAY); // 75
  });

  it("treats any positive prior steps as fatigue when avgStep30d is 0", () => {
    const fatigued = computeGraceDeadline({
      mean: 420,
      stdDev: 0,
      isWeekend: false,
      priorDaySteps: 1,
      avgStep30d: 0,
    });
    expect(fatigued.appliedFatigueOffsetMin).toBe(DEFAULT_FATIGUE_OFFSET_MIN);

    const notFatigued = computeGraceDeadline({
      mean: 420,
      stdDev: 0,
      isWeekend: false,
      priorDaySteps: 0,
      avgStep30d: 0,
    });
    expect(notFatigued.appliedFatigueOffsetMin).toBe(0);
  });
});

describe("updateProfileOnWakeEvent (R4.8)", () => {
  it("appends a sample and recomputes the baseline on a partial window", () => {
    const updated = updateProfileOnWakeEvent(
      { wakeSamples: [400], meanWakeMinute: 400, stdDevWakeMinute: 0 },
      440,
    );
    expect(updated.wakeSamples).toEqual([400, 440]);
    expect(updated.meanWakeMinute).toBe(420);
    expect(updated.stdDevWakeMinute).toBe(20);
  });

  it("evicts the oldest sample once the window exceeds 14 (rolling)", () => {
    // Fill exactly 14 samples of 400, then push a 15th.
    const wakeSamples = Array.from({ length: 14 }, () => 400);
    const updated = updateProfileOnWakeEvent(
      { wakeSamples, meanWakeMinute: 400, stdDevWakeMinute: 0 },
      460,
    );
    expect(updated.wakeSamples).toHaveLength(ROLLING_WINDOW_DAYS);
    // Oldest 400 dropped; window is 13 x 400 + 460.
    expect(updated.wakeSamples[updated.wakeSamples.length - 1]).toBe(460);
    expect(updated.wakeSamples[0]).toBe(400);
    const expectedMean = (13 * 400 + 460) / 14;
    expect(updated.meanWakeMinute).toBeCloseTo(expectedMean, 10);
  });

  it("does not mutate the input profile", () => {
    const original = { wakeSamples: [400], meanWakeMinute: 400, stdDevWakeMinute: 0 };
    updateProfileOnWakeEvent(original, 440);
    expect(original.wakeSamples).toEqual([400]);
    expect(original.meanWakeMinute).toBe(400);
  });

  it("initializes a profile from an empty sample set", () => {
    const updated = updateProfileOnWakeEvent(
      { wakeSamples: [], meanWakeMinute: 0, stdDevWakeMinute: 0 },
      405,
    );
    expect(updated.wakeSamples).toEqual([405]);
    expect(updated.meanWakeMinute).toBe(405);
    expect(updated.stdDevWakeMinute).toBe(0);
  });
});
