import { describe, expect, it, vi } from "vitest";

import type { Job } from "bullmq";
import type { PrismaClient } from "@kshema/database";
import type { ProcessorContext } from "../jobs/registry.js";
import {
  confirmPendingCheck,
  createGhostReceivedHandler,
  createInMemoryGraceCheckStore,
  createRhythmEvalProcessor,
  createTelemetryReceivedHandler,
  ghostToConfirmingSignal,
  graceCheckStateKey,
  telemetryToConfirmingSignal,
  type GraceCheckJobData,
  type RhythmEvalDeps,
  type ScheduleGraceCheckJobData,
} from "./rhythm-eval.js";
import { createGraceCheckState } from "./confirming-signal.js";
import type { ElderlyCareInput } from "./evaluators.js";
import {
  createSanctuaryGate,
  type SanctuaryWindow,
} from "../sanctuary/gate.js";

const fakePrisma = {} as unknown as PrismaClient;
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: ProcessorContext = { prisma: fakePrisma, logger: silentLogger };

function job(name: string, data: unknown): Job {
  return { name, data } as unknown as Job;
}

const DAY_START = Date.UTC(2025, 0, 31, 0, 0, 0);
const MS_PER_MINUTE = 60_000;

function elderly(overrides: Partial<ElderlyCareInput> = {}): ElderlyCareInput {
  return {
    mean: 420,
    stdDev: 0,
    isWeekend: false,
    priorDaySteps: 0,
    avgStep30d: 0,
    nowMinuteOfDay: 900,
    routineConfirmed: false,
    ...overrides,
  };
}

describe("telemetryToConfirmingSignal payload mapping", () => {
  it("maps screen unlock", () => {
    expect(telemetryToConfirmingSignal({ screenUnlock: true, at: 5 })).toEqual({
      type: "screen_unlock",
      at: 5,
    });
  });

  it("maps a positive step delta only", () => {
    expect(
      telemetryToConfirmingSignal({ stepDelta: 9, at: 5 }),
    ).toEqual({ type: "step_delta", at: 5, stepDelta: 9 });
    expect(telemetryToConfirmingSignal({ stepDelta: 0, at: 5 })).toBeNull();
  });

  it("maps a charger unplug", () => {
    expect(
      telemetryToConfirmingSignal({ chargerUnplugged: true, at: 5 }),
    ).toEqual({ type: "charger_unplug", at: 5 });
  });

  it("returns null when no confirming evidence is present", () => {
    expect(telemetryToConfirmingSignal({ battery: 80, at: 5 })).toBeNull();
    expect(telemetryToConfirmingSignal(null)).toBeNull();
  });
});

describe("ghostToConfirmingSignal", () => {
  it("always yields a ghost_signal confirming signal (R6.4)", () => {
    expect(ghostToConfirmingSignal({ at: 7 })).toEqual({
      type: "ghost_signal",
      at: 7,
    });
  });
});

describe("confirmPendingCheck", () => {
  it("confirms a pending check when the signal beats the deadline", () => {
    const store = createInMemoryGraceCheckStore();
    store.set(
      createGraceCheckState({
        anchorId: "a1",
        serviceDay: "2025-01-31",
        deadline: 1000,
      }),
    );
    const next = confirmPendingCheck(store, "a1", "2025-01-31", {
      type: "screen_unlock",
      at: 500,
    });
    expect(next?.confirmed).toBe(true);
    expect(store.get(graceCheckStateKey("a1", "2025-01-31"))?.confirmed).toBe(
      true,
    );
  });

  it("returns null when there is no pending check", () => {
    const store = createInMemoryGraceCheckStore();
    expect(
      confirmPendingCheck(store, "a1", "2025-01-31", {
        type: "ghost_signal",
        at: 1,
      }),
    ).toBeNull();
  });
});

describe("rhythm-eval processor — schedule-grace-check", () => {
  it("registers a pending state and enqueues the descriptor", async () => {
    const store = createInMemoryGraceCheckStore();
    const enqueueGraceCheck = vi.fn().mockResolvedValue(undefined);
    const openIncident = vi.fn().mockResolvedValue(undefined);
    const deps: RhythmEvalDeps = { store, enqueueGraceCheck, openIncident };
    const process = createRhythmEvalProcessor(deps);

    const data: ScheduleGraceCheckJobData = {
      anchorId: "a1",
      serviceDay: "2025-01-31",
      dayStart: DAY_START,
      now: DAY_START,
      deadline: {
        mean: 420,
        stdDev: 0,
        isWeekend: false,
        priorDaySteps: 0,
        avgStep30d: 0,
      },
    };
    const result = (await process(
      job("schedule-grace-check", data),
      ctx,
    )) as { scheduled: boolean; jobId: string };

    expect(result.scheduled).toBe(true);
    expect(enqueueGraceCheck).toHaveBeenCalledTimes(1);
    const state = store.get(graceCheckStateKey("a1", "2025-01-31"));
    expect(state).toBeDefined();
    expect(state?.confirmed).toBe(false);
    expect(state?.deadline).toBe(DAY_START + 420 * MS_PER_MINUTE);
  });
});

describe("rhythm-eval processor — grace-check escalation decision", () => {
  function makeDeps() {
    const store = createInMemoryGraceCheckStore();
    const enqueueGraceCheck = vi.fn().mockResolvedValue(undefined);
    const openIncident = vi.fn().mockResolvedValue(undefined);
    const deps: RhythmEvalDeps = { store, enqueueGraceCheck, openIncident };
    return { store, openIncident, deps };
  }

  const graceData = (): GraceCheckJobData => ({
    anchorId: "a1",
    serviceDay: "2025-01-31",
    enabledModes: ["ELDERLY_CARE"],
    personaInputs: { ELDERLY_CARE: elderly({ nowMinuteOfDay: 900 }) }, // past deadline
  });

  it("opens an incident when a mode triggers and the routine is unconfirmed", async () => {
    const { store, openIncident, deps } = makeDeps();
    store.set(
      createGraceCheckState({
        anchorId: "a1",
        serviceDay: "2025-01-31",
        deadline: 1000,
      }),
    );
    const process = createRhythmEvalProcessor(deps);
    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
    };
    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("PREVENTS escalation when a confirming signal marked the check confirmed (R5.6/R6.5)", async () => {
    const { store, openIncident, deps } = makeDeps();
    store.set(
      createGraceCheckState({
        anchorId: "a1",
        serviceDay: "2025-01-31",
        deadline: 1000,
      }),
    );
    // A ghost signal before the deadline confirms via the wired handler.
    const ghostHandler = createGhostReceivedHandler({ store });
    await ghostHandler(
      {
        name: "ghost.received",
        payload: { anchorId: "a1", serviceDay: "2025-01-31", at: 500 },
      },
      ctx,
    );

    const process = createRhythmEvalProcessor(deps);
    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
      confirmed: boolean;
    };
    expect(result.escalated).toBe(false);
    expect(result.confirmed).toBe(true);
    expect(openIncident).not.toHaveBeenCalled();
  });

  it("does not escalate when no enabled mode triggers", async () => {
    const { store, openIncident, deps } = makeDeps();
    store.set(
      createGraceCheckState({
        anchorId: "a1",
        serviceDay: "2025-01-31",
        deadline: 1000,
      }),
    );
    const process = createRhythmEvalProcessor(deps);
    const data: GraceCheckJobData = {
      anchorId: "a1",
      serviceDay: "2025-01-31",
      enabledModes: ["ELDERLY_CARE"],
      personaInputs: { ELDERLY_CARE: elderly({ nowMinuteOfDay: 100 }) }, // before deadline
    };
    const result = (await process(job("grace-check", data), ctx)) as {
      escalated: boolean;
    };
    expect(result.escalated).toBe(false);
    expect(openIncident).not.toHaveBeenCalled();
  });
});

describe("telemetry.received handler — end-to-end confirmation", () => {
  it("a positive step delta before the deadline prevents escalation", async () => {
    const store = createInMemoryGraceCheckStore();
    store.set(
      createGraceCheckState({
        anchorId: "a1",
        serviceDay: "2025-01-31",
        deadline: 1000,
      }),
    );
    const handler = createTelemetryReceivedHandler({ store });
    const res = (await handler(
      {
        name: "telemetry.received",
        payload: {
          anchorId: "a1",
          serviceDay: "2025-01-31",
          stepDelta: 20,
          at: 400,
        },
      },
      ctx,
    )) as { confirmed: boolean };
    expect(res.confirmed).toBe(true);
    expect(store.get(graceCheckStateKey("a1", "2025-01-31"))?.confirmed).toBe(
      true,
    );
  });

  it("a signal after the deadline does not confirm", async () => {
    const store = createInMemoryGraceCheckStore();
    store.set(
      createGraceCheckState({
        anchorId: "a1",
        serviceDay: "2025-01-31",
        deadline: 1000,
      }),
    );
    const handler = createTelemetryReceivedHandler({ store });
    const res = (await handler(
      {
        name: "telemetry.received",
        payload: {
          anchorId: "a1",
          serviceDay: "2025-01-31",
          screenUnlock: true,
          at: 1500,
        },
      },
      ctx,
    )) as { confirmed: boolean };
    expect(res.confirmed).toBe(false);
  });
});

describe("rhythm-eval processor — Sanctuary Mode suppression (R34.2)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function makeDeps(sanctuaryGate?: RhythmEvalDeps["sanctuaryGate"]) {
    const store = createInMemoryGraceCheckStore();
    const enqueueGraceCheck = vi.fn().mockResolvedValue(undefined);
    const openIncident = vi.fn().mockResolvedValue(undefined);
    const deps: RhythmEvalDeps = {
      store,
      enqueueGraceCheck,
      openIncident,
      sanctuaryGate,
    };
    return { store, openIncident, deps };
  }

  // A grace-check that WOULD escalate absent Sanctuary: unconfirmed + past deadline.
  const escalatingGraceData = (): GraceCheckJobData => ({
    anchorId: "a1",
    serviceDay: "2025-01-31",
    enabledModes: ["ELDERLY_CARE"],
    personaInputs: { ELDERLY_CARE: elderly({ nowMinuteOfDay: 900 }) },
  });

  function seedPending(store: ReturnType<typeof createInMemoryGraceCheckStore>) {
    store.set(
      createGraceCheckState({
        anchorId: "a1",
        serviceDay: "2025-01-31",
        deadline: 1000,
      }),
    );
  }

  const activeWindow = (): SanctuaryWindow => {
    const start = Date.now() - DAY_MS;
    return {
      userId: "a1",
      startsAt: start,
      resumesAt: start + 3 * DAY_MS, // now is inside [start, resume)
      isActive: true,
    };
  };

  it("suppresses incident opening while Sanctuary is active — no incident opens", async () => {
    const gate = createSanctuaryGate(() => [activeWindow()]);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", escalatingGraceData()),
      ctx,
    )) as { escalated: boolean; suppressedBy?: string };

    expect(result.escalated).toBe(false);
    expect(result.suppressedBy).toBe("sanctuary");
    expect(openIncident).not.toHaveBeenCalled();
  });

  it("does NOT suppress before the window begins — incident opens normally", async () => {
    const start = Date.now() + DAY_MS; // window is in the future
    const gate = createSanctuaryGate(() => [
      { userId: "a1", startsAt: start, resumesAt: start + DAY_MS, isActive: true },
    ]);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", escalatingGraceData()),
      ctx,
    )) as { escalated: boolean };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("auto-resumes at/after resumesAt — incident opens with no reactivation (R34.4)", async () => {
    const start = Date.now() - 5 * DAY_MS;
    const fetch = vi.fn(() => [
      { userId: "a1", startsAt: start, resumesAt: start + DAY_MS, isActive: true },
    ]);
    const gate = createSanctuaryGate(fetch);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", escalatingGraceData()),
      ctx,
    )) as { escalated: boolean };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
    // The gate only read the schedule; it never wrote a "resumed" flag.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("without a gate configured, behaviour is unchanged (opens incident)", async () => {
    const { store, openIncident, deps } = makeDeps(undefined);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", escalatingGraceData()),
      ctx,
    )) as { escalated: boolean };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("Sanctuary is only consulted when evaluation would otherwise escalate", async () => {
    // A confirmed routine already withholds escalation; the gate must not even
    // be consulted, and the streak-bearing decision path is untouched (R34.5).
    const fetch = vi.fn(() => [activeWindow()]);
    const gate = createSanctuaryGate(fetch);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    // Confirm the routine so canEscalate is false.
    confirmPendingCheck(store, "a1", "2025-01-31", {
      type: "ghost_signal",
      at: 500,
    });
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", escalatingGraceData()),
      ctx,
    )) as { escalated: boolean; confirmed?: boolean };

    expect(result.escalated).toBe(false);
    expect(openIncident).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
