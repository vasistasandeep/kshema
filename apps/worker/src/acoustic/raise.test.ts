import { describe, expect, it, vi } from "vitest";

import { escalationJobId } from "../jobs/job-id.js";
import type { AuditEntry, ScheduledAdvance, StageSideEffect } from "../escalation/fsm.js";
import {
  ACOUSTIC_CAUSE,
  raiseAcousticIncident,
  shouldRaiseAcousticIncident,
  type AcousticRaiseDeps,
  type AcousticSignal,
} from "./raise.js";

const STAGE_INTERVAL_MS = 20 * 60 * 1000;
const NOW = Date.UTC(2025, 0, 31, 22, 15, 0);

/** A signal that clears every threshold. */
const QUALIFYING: AcousticSignal = {
  confidence: 0.9,
  sustainedSec: 2,
  motionlessSec: 45,
};

/**
 * Spying acoustic-raise deps over a tiny in-memory incident store. Every seam
 * records its calls so tests can assert on the STAGE_2 create, the chime, and
 * the scheduled STAGE_3 advance without a live Redis/DB.
 */
function makeDeps() {
  const incidents = new Map<
    string,
    { id: string; stage: string; cause: string; auditTrail: AuditEntry[] }
  >();
  const scheduled: ScheduledAdvance[] = [];
  const effects: StageSideEffect[] = [];
  let seq = 0;

  const deps: AcousticRaiseDeps = {
    createIncidentAtStage: vi.fn(async (input) => {
      const id = `incident-${++seq}`;
      incidents.set(id, {
        id,
        stage: input.stage,
        cause: input.cause,
        auditTrail: [...input.auditTrail],
      });
      return { id };
    }),
    performSideEffect: vi.fn(async (effect) => {
      effects.push(effect);
    }),
    scheduleAdvance: vi.fn(async (advance) => {
      scheduled.push(advance);
    }),
  };

  return { deps, incidents, scheduled, effects };
}

describe("shouldRaiseAcousticIncident (R10.3, R10.4)", () => {
  it("qualifies when all three thresholds are cleared", () => {
    expect(shouldRaiseAcousticIncident(QUALIFYING)).toBe(true);
  });

  describe("confidence boundary (> 0.82, strict — R10.4 excludes <= 0.82)", () => {
    it("excludes confidence exactly at 0.82", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.82, sustainedSec: 2, motionlessSec: 45 }),
      ).toBe(false);
    });

    it("excludes confidence below 0.82", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.5, sustainedSec: 2, motionlessSec: 45 }),
      ).toBe(false);
    });

    it("includes confidence just above 0.82", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.821, sustainedSec: 2, motionlessSec: 45 }),
      ).toBe(true);
    });
  });

  describe("sustained boundary (> 1.5s, strict)", () => {
    it("excludes sustained exactly at 1.5s", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 1.5, motionlessSec: 45 }),
      ).toBe(false);
    });

    it("excludes sustained below 1.5s", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 1.0, motionlessSec: 45 }),
      ).toBe(false);
    });

    it("includes sustained just above 1.5s", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 1.51, motionlessSec: 45 }),
      ).toBe(true);
    });
  });

  describe("motionless boundary (>= 30s, inclusive)", () => {
    it("includes motionless exactly at 30s", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 2, motionlessSec: 30 }),
      ).toBe(true);
    });

    it("excludes motionless below 30s", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 2, motionlessSec: 29.999 }),
      ).toBe(false);
    });

    it("includes motionless above 30s", () => {
      expect(
        shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 2, motionlessSec: 120 }),
      ).toBe(true);
    });
  });

  it("requires ALL three conditions (each alone is insufficient)", () => {
    // Only confidence clears.
    expect(
      shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 1.0, motionlessSec: 10 }),
    ).toBe(false);
    // Only sustained clears.
    expect(
      shouldRaiseAcousticIncident({ confidence: 0.5, sustainedSec: 2.0, motionlessSec: 10 }),
    ).toBe(false);
    // Only motionless clears.
    expect(
      shouldRaiseAcousticIncident({ confidence: 0.5, sustainedSec: 1.0, motionlessSec: 45 }),
    ).toBe(false);
  });

  it("never qualifies on non-finite inputs", () => {
    expect(
      shouldRaiseAcousticIncident({ confidence: NaN, sustainedSec: 2, motionlessSec: 45 }),
    ).toBe(false);
    expect(
      shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: NaN, motionlessSec: 45 }),
    ).toBe(false);
    expect(
      shouldRaiseAcousticIncident({ confidence: 0.9, sustainedSec: 2, motionlessSec: NaN }),
    ).toBe(false);
  });
});

describe("raiseAcousticIncident (R10.3, R10.4)", () => {
  it("raises a qualifying classification directly at STAGE_2 with the acoustic cause", async () => {
    const { deps, incidents, scheduled, effects } = makeDeps();

    const outcome = await raiseAcousticIncident(deps, {
      circleId: "circle1",
      anchorId: "anchor1",
      signal: QUALIFYING,
      now: NOW,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });

    expect(outcome.raised).toBe(true);
    if (!outcome.raised) throw new Error("expected raise");

    // Created directly at STAGE_2 (NOT STAGE_1) with the acoustic cause.
    expect(outcome.stage).toBe("STAGE_2_GENTLE_DEVICE_CHIME");
    expect(deps.createIncidentAtStage).toHaveBeenCalledOnce();
    const rec = incidents.get(outcome.incidentId)!;
    expect(rec.stage).toBe("STAGE_2_GENTLE_DEVICE_CHIME");
    expect(rec.cause).toBe(ACOUSTIC_CAUSE);
    expect(rec.auditTrail).toEqual([
      { stage: "STAGE_2_GENTLE_DEVICE_CHIME", at: NOW, cause: ACOUSTIC_CAUSE },
    ]);

    // STAGE_2 device chime fired.
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      incidentId: outcome.incidentId,
      anchorId: "anchor1",
      stage: "STAGE_2_GENTLE_DEVICE_CHIME",
      kind: "device_chime",
    });

    // STAGE_3 advance scheduled with the deterministic jobId + interval delay.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      jobId: escalationJobId(outcome.incidentId, 3),
      targetStage: "STAGE_3_OBSERVER_SILENT_ALERT",
      delayMs: STAGE_INTERVAL_MS,
      data: {
        incidentId: outcome.incidentId,
        targetStage: "STAGE_3_OBSERVER_SILENT_ALERT",
      },
    });
    expect(outcome.scheduled.jobId).toBe(escalationJobId(outcome.incidentId, 3));
  });

  it("raises nothing for a sub-threshold classification (R10.4)", async () => {
    const { deps, incidents, scheduled, effects } = makeDeps();

    const outcome = await raiseAcousticIncident(deps, {
      circleId: "circle1",
      anchorId: "anchor1",
      // confidence exactly at the excluded boundary.
      signal: { confidence: 0.82, sustainedSec: 2, motionlessSec: 45 },
      now: NOW,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });

    expect(outcome).toEqual({ raised: false, reason: "below-threshold" });
    expect(deps.createIncidentAtStage).not.toHaveBeenCalled();
    expect(deps.performSideEffect).not.toHaveBeenCalled();
    expect(deps.scheduleAdvance).not.toHaveBeenCalled();
    expect(incidents.size).toBe(0);
    expect(effects).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("honors an injectable compressed stage interval (Simulation_Mode)", async () => {
    const { deps, scheduled } = makeDeps();
    await raiseAcousticIncident(deps, {
      circleId: "c",
      anchorId: "a",
      signal: QUALIFYING,
      now: NOW,
      stageIntervalMs: 10_000,
      simulated: true,
    });
    expect(scheduled[0]!.delayMs).toBe(10_000);
    expect(deps.createIncidentAtStage).toHaveBeenCalledWith(
      expect.objectContaining({ simulated: true, stage: "STAGE_2_GENTLE_DEVICE_CHIME" }),
    );
  });
});
