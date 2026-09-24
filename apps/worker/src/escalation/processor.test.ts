import { describe, expect, it, vi } from "vitest";

import type { Job } from "bullmq";
import type { PrismaClient } from "@kshema/database";

import type { ProcessorContext } from "../jobs/registry.js";
import { escalationJobId } from "../jobs/job-id.js";
import {
  createEscalationProcessor,
  DEFAULT_STAGE_INTERVAL_MS,
  type EscalationProcessorDeps,
} from "./processor.js";
import type { IncidentSnapshot, ScheduledAdvance, StageSideEffect } from "./fsm.js";

const fakePrisma = {} as unknown as PrismaClient;
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: ProcessorContext = { prisma: fakePrisma, logger: silentLogger };

function job(name: string, data: unknown): Job {
  return { name, data } as unknown as Job;
}

const NOW = 1_700_000_000_000;

function makeProcessorDeps(open?: IncidentSnapshot) {
  const scheduled: ScheduledAdvance[] = [];
  const effects: StageSideEffect[] = [];
  const store = new Map<string, IncidentSnapshot>();
  if (open) store.set(open.id, { ...open });

  const deps: EscalationProcessorDeps = {
    now: () => NOW,
    createIncident: vi.fn(async () => {
      store.set("inc-created", {
        id: "inc-created",
        stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
        status: "OPEN",
      });
      return { id: "inc-created" };
    }),
    readIncident: vi.fn(async (id) => store.get(id) ?? null),
    applyAdvance: vi.fn(async ({ incidentId, stage }) => {
      const rec = store.get(incidentId);
      if (rec) rec.stage = stage;
    }),
    scheduleAdvance: vi.fn(async (a) => {
      scheduled.push(a);
    }),
    performSideEffect: vi.fn(async (e) => {
      effects.push(e);
    }),
  };
  return { deps, scheduled, effects };
}

describe("createEscalationProcessor", () => {
  it("processes an `open` job: STAGE_1 + WhatsApp + stage2 schedule", async () => {
    const { deps, scheduled, effects } = makeProcessorDeps();
    const processor = createEscalationProcessor(deps);

    const res = (await processor(
      job("open", { circleId: "c1", anchorId: "a1", cause: "GRACE_DEADLINE_MISS" }),
      ctx,
    )) as { opened: boolean; incidentId: string; stage: string; scheduledJobId: string };

    expect(res.opened).toBe(true);
    expect(res.stage).toBe("STAGE_1_CONVERSATIONAL_WHATSAPP");
    expect(effects[0]!.kind).toBe("whatsapp_checkin");
    expect(scheduled[0]!.jobId).toBe(escalationJobId(res.incidentId, 2));
    expect(scheduled[0]!.delayMs).toBe(DEFAULT_STAGE_INTERVAL_MS);
  });

  it("processes an `advance` job: moves one stage and schedules the next", async () => {
    const { deps, scheduled, effects } = makeProcessorDeps({
      id: "inc1",
      stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
      status: "OPEN",
    });
    const processor = createEscalationProcessor(deps);

    const res = (await processor(
      job("advance", { incidentId: "inc1", targetStage: "STAGE_2_GENTLE_DEVICE_CHIME" }),
      ctx,
    )) as { advanced: boolean; stage: string; effect: string; scheduledJobId: string | null };

    expect(res.advanced).toBe(true);
    expect(res.stage).toBe("STAGE_2_GENTLE_DEVICE_CHIME");
    expect(res.effect).toBe("device_chime");
    expect(effects[0]!.kind).toBe("device_chime");
    expect(scheduled[0]!.jobId).toBe(escalationJobId("inc1", 3));
    expect(res.scheduledJobId).toBe(escalationJobId("inc1", 3));
  });

  it("advance on a RESOLVED incident is a reported no-op", async () => {
    const { deps, scheduled, effects } = makeProcessorDeps({
      id: "inc1",
      stage: "STAGE_2_GENTLE_DEVICE_CHIME",
      status: "RESOLVED",
    });
    const processor = createEscalationProcessor(deps);

    const res = (await processor(
      job("advance", { incidentId: "inc1", targetStage: "STAGE_3_OBSERVER_SILENT_ALERT" }),
      ctx,
    )) as { advanced: boolean; reason: string };

    expect(res).toEqual({ advanced: false, reason: "not-open" });
    expect(effects).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("ignores an unknown job name", async () => {
    const { deps } = makeProcessorDeps();
    const processor = createEscalationProcessor(deps);
    const res = (await processor(job("bogus", {}), ctx)) as { ignored: boolean };
    expect(res.ignored).toBe(true);
  });
});
