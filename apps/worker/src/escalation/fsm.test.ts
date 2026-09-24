import { describe, expect, it, vi } from "vitest";

import type { IncidentStage, IncidentStatus } from "@kshema/database";

import { escalationJobId } from "../jobs/job-id.js";
import {
  advanceIncident,
  nextStage,
  openIncident,
  sideEffectForStage,
  stageNumber,
  STAGE_ORDER,
  type AuditEntry,
  type EscalationDeps,
  type IncidentSnapshot,
  type ScheduledAdvance,
  type StageSideEffect,
} from "./fsm.js";

const STAGE_INTERVAL_MS = 20 * 60 * 1000;
const NOW = Date.UTC(2025, 0, 31, 7, 30, 0);

/**
 * Build a spying set of escalation deps over a tiny in-memory incident store.
 * Every seam records its calls so tests can assert on side effects, audit
 * appends, and scheduled jobs without a live Redis/DB.
 */
function makeDeps(initial?: Partial<IncidentSnapshot>) {
  const incidents = new Map<string, IncidentSnapshot & { auditTrail: AuditEntry[] }>();
  const scheduled: ScheduledAdvance[] = [];
  const effects: StageSideEffect[] = [];
  let seq = 0;

  if (initial?.id) {
    incidents.set(initial.id, {
      id: initial.id,
      stage: initial.stage ?? "STAGE_1_CONVERSATIONAL_WHATSAPP",
      status: initial.status ?? "OPEN",
      auditTrail: [],
    });
  }

  const deps: EscalationDeps = {
    createIncident: vi.fn(async (input) => {
      const id = `incident-${++seq}`;
      incidents.set(id, {
        id,
        stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
        status: "OPEN",
        auditTrail: [...input.auditTrail],
      });
      return { id };
    }),
    readIncident: vi.fn(async (id) => {
      const rec = incidents.get(id);
      if (!rec) return null;
      return { id: rec.id, stage: rec.stage, status: rec.status };
    }),
    applyAdvance: vi.fn(async ({ incidentId, stage, entry }) => {
      const rec = incidents.get(incidentId);
      if (!rec) throw new Error(`applyAdvance: no incident ${incidentId}`);
      rec.stage = stage;
      rec.auditTrail.push(entry);
    }),
    scheduleAdvance: vi.fn(async (advance) => {
      scheduled.push(advance);
    }),
    performSideEffect: vi.fn(async (effect) => {
      effects.push(effect);
    }),
  };

  return { deps, incidents, scheduled, effects };
}

describe("stage helpers", () => {
  it("STAGE_ORDER maps to ordinals 1..4", () => {
    expect(STAGE_ORDER.map(stageNumber)).toEqual([1, 2, 3, 4]);
  });

  it("nextStage steps strictly through the ladder and terminates at STAGE_4", () => {
    expect(nextStage("STAGE_1_CONVERSATIONAL_WHATSAPP")).toBe(
      "STAGE_2_GENTLE_DEVICE_CHIME",
    );
    expect(nextStage("STAGE_2_GENTLE_DEVICE_CHIME")).toBe(
      "STAGE_3_OBSERVER_SILENT_ALERT",
    );
    expect(nextStage("STAGE_3_OBSERVER_SILENT_ALERT")).toBe(
      "STAGE_4_HYPERLOCAL_DISPATCH",
    );
    expect(nextStage("STAGE_4_HYPERLOCAL_DISPATCH")).toBeNull();
  });

  it("maps each stage to its side-effect kind", () => {
    expect(sideEffectForStage("STAGE_1_CONVERSATIONAL_WHATSAPP")).toBe(
      "whatsapp_checkin",
    );
    expect(sideEffectForStage("STAGE_2_GENTLE_DEVICE_CHIME")).toBe(
      "device_chime",
    );
    expect(sideEffectForStage("STAGE_3_OBSERVER_SILENT_ALERT")).toBe(
      "observer_silent_push",
    );
    expect(sideEffectForStage("STAGE_4_HYPERLOCAL_DISPATCH")).toBe(
      "hyperlocal_dispatch",
    );
  });
});

describe("openIncident (R12.1)", () => {
  it("creates a STAGE_1 incident, dispatches WhatsApp, and schedules stage2", async () => {
    const { deps, incidents, scheduled, effects } = makeDeps();

    const result = await openIncident(deps, {
      circleId: "circle1",
      anchorId: "anchor1",
      cause: "GRACE_DEADLINE_MISS",
      now: NOW,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });

    // Created at STAGE_1 with a STAGE_1 audit entry.
    expect(result.stage).toBe("STAGE_1_CONVERSATIONAL_WHATSAPP");
    expect(deps.createIncident).toHaveBeenCalledOnce();
    const rec = incidents.get(result.incidentId)!;
    expect(rec.stage).toBe("STAGE_1_CONVERSATIONAL_WHATSAPP");
    expect(rec.auditTrail).toEqual([
      {
        stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
        at: NOW,
        cause: "GRACE_DEADLINE_MISS",
      },
    ]);

    // WhatsApp conversational check-in dispatched for STAGE_1.
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      incidentId: result.incidentId,
      anchorId: "anchor1",
      stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
      kind: "whatsapp_checkin",
    });

    // STAGE_2 advance scheduled with the deterministic jobId + interval delay.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      jobId: escalationJobId(result.incidentId, 2),
      targetStage: "STAGE_2_GENTLE_DEVICE_CHIME",
      delayMs: STAGE_INTERVAL_MS,
      data: { incidentId: result.incidentId, targetStage: "STAGE_2_GENTLE_DEVICE_CHIME" },
    });
    expect(result.scheduled.jobId).toBe(escalationJobId(result.incidentId, 2));
  });

  it("honors an injectable compressed stage interval (Simulation_Mode)", async () => {
    const { deps, scheduled } = makeDeps();
    await openIncident(deps, {
      circleId: "c",
      anchorId: "a",
      cause: "x",
      now: NOW,
      stageIntervalMs: 10_000,
      simulated: true,
    });
    expect(scheduled[0]!.delayMs).toBe(10_000);
    expect(deps.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ simulated: true }),
    );
  });
});

describe("advanceIncident (R12.2–12.5)", () => {
  it("advances exactly one stage (1→2), fires the chime, and schedules stage3", async () => {
    const { deps, incidents, scheduled, effects } = makeDeps({
      id: "inc1",
      stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
      status: "OPEN",
    });

    const outcome = await advanceIncident(deps, {
      incidentId: "inc1",
      now: NOW,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });

    expect(outcome.advanced).toBe(true);
    if (!outcome.advanced) throw new Error("expected advance");
    expect(outcome.stage).toBe("STAGE_2_GENTLE_DEVICE_CHIME");
    expect(incidents.get("inc1")!.stage).toBe("STAGE_2_GENTLE_DEVICE_CHIME");

    // device chime side-effect.
    expect(effects).toEqual([
      { incidentId: "inc1", stage: "STAGE_2_GENTLE_DEVICE_CHIME", kind: "device_chime" },
    ]);

    // schedules stage3 with the right jobId.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.jobId).toBe(escalationJobId("inc1", 3));
    expect(scheduled[0]!.targetStage).toBe("STAGE_3_OBSERVER_SILENT_ALERT");

    // audit entry appended in order.
    expect(incidents.get("inc1")!.auditTrail).toEqual([
      expect.objectContaining({ stage: "STAGE_2_GENTLE_DEVICE_CHIME", at: NOW }),
    ]);
  });

  it("advances 2→3 with observer silent push and schedules stage4", async () => {
    const { deps, scheduled, effects } = makeDeps({
      id: "inc1",
      stage: "STAGE_2_GENTLE_DEVICE_CHIME",
      status: "OPEN",
    });
    const outcome = await advanceIncident(deps, {
      incidentId: "inc1",
      now: NOW,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });
    expect(outcome.advanced && outcome.stage).toBe("STAGE_3_OBSERVER_SILENT_ALERT");
    expect(effects[0]!.kind).toBe("observer_silent_push");
    expect(scheduled[0]!.jobId).toBe(escalationJobId("inc1", 4));
  });

  it("STAGE_4 advance performs hyperlocal dispatch and schedules nothing further", async () => {
    const { deps, incidents, scheduled, effects } = makeDeps({
      id: "inc1",
      stage: "STAGE_3_OBSERVER_SILENT_ALERT",
      status: "OPEN",
    });

    const outcome = await advanceIncident(deps, {
      incidentId: "inc1",
      now: NOW,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });

    expect(outcome.advanced).toBe(true);
    if (!outcome.advanced) throw new Error("expected advance");
    expect(outcome.stage).toBe("STAGE_4_HYPERLOCAL_DISPATCH");
    expect(incidents.get("inc1")!.stage).toBe("STAGE_4_HYPERLOCAL_DISPATCH");
    expect(effects[0]!.kind).toBe("hyperlocal_dispatch");

    // Terminal: no further advance scheduled.
    expect(scheduled).toHaveLength(0);
    expect(outcome.scheduled).toBeNull();
  });

  it.each<IncidentStatus>(["RESOLVED", "HANDED_OFF_SOS"])(
    "is a strict no-op on a %s incident (no effects, no scheduling, no audit)",
    async (status) => {
      const { deps, incidents, scheduled, effects } = makeDeps({
        id: "inc1",
        stage: "STAGE_2_GENTLE_DEVICE_CHIME",
        status,
      });

      const outcome = await advanceIncident(deps, {
        incidentId: "inc1",
        now: NOW,
        stageIntervalMs: STAGE_INTERVAL_MS,
      });

      expect(outcome).toEqual({ advanced: false, reason: "not-open", status });
      expect(deps.applyAdvance).not.toHaveBeenCalled();
      expect(effects).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
      // stage + audit untouched.
      expect(incidents.get("inc1")!.stage).toBe("STAGE_2_GENTLE_DEVICE_CHIME");
      expect(incidents.get("inc1")!.auditTrail).toHaveLength(0);
    },
  );

  it("is a no-op when the incident no longer exists", async () => {
    const { deps, scheduled, effects } = makeDeps();
    const outcome = await advanceIncident(deps, {
      incidentId: "missing",
      now: NOW,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });
    expect(outcome).toEqual({ advanced: false, reason: "not-found" });
    expect(effects).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("accrues the audit trail {stage,at,cause} in strict order across the full ladder", async () => {
    // Open, then advance through 2→3→4 driving the shared in-memory store.
    const { deps, incidents } = makeDeps();
    const opened = await openIncident(deps, {
      circleId: "c",
      anchorId: "a",
      cause: "GRACE_DEADLINE_MISS",
      now: 1_000,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });
    const id = opened.incidentId;

    await advanceIncident(deps, { incidentId: id, now: 2_000, stageIntervalMs: STAGE_INTERVAL_MS });
    await advanceIncident(deps, { incidentId: id, now: 3_000, stageIntervalMs: STAGE_INTERVAL_MS });
    await advanceIncident(deps, { incidentId: id, now: 4_000, stageIntervalMs: STAGE_INTERVAL_MS });

    const stages = incidents.get(id)!.auditTrail.map((e) => e.stage);
    const times = incidents.get(id)!.auditTrail.map((e) => e.at);
    expect(stages).toEqual([
      "STAGE_1_CONVERSATIONAL_WHATSAPP",
      "STAGE_2_GENTLE_DEVICE_CHIME",
      "STAGE_3_OBSERVER_SILENT_ALERT",
      "STAGE_4_HYPERLOCAL_DISPATCH",
    ] satisfies IncidentStage[]);
    expect(times).toEqual([1_000, 2_000, 3_000, 4_000]);

    // A further advance at terminal STAGE_4 is a no-op.
    const extra = await advanceIncident(deps, {
      incidentId: id,
      now: 5_000,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });
    expect(extra.advanced).toBe(false);
    expect(incidents.get(id)!.auditTrail).toHaveLength(4);
  });
});
