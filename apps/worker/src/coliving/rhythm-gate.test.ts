/**
 * Unit tests for the co-living confirmation gate (R35.2) AND its wiring into
 * the rhythm-eval routine grace-check decision.
 *
 * These live under `coliving/` (rather than in `personas/rhythm-eval.test.ts`)
 * because tasks 13.1/17.3 may edit that file concurrently; keeping the co-living
 * wiring assertions here avoids a save conflict while still exercising the real
 * processor.
 */
import { describe, expect, it, vi } from "vitest";

import type { Job } from "bullmq";
import type { PrismaClient } from "@kshema/database";

import type { ProcessorContext } from "../jobs/registry.js";
import {
  createInMemoryGraceCheckStore,
  createRhythmEvalProcessor,
  type GraceCheckJobData,
  type RhythmEvalDeps,
} from "../personas/rhythm-eval.js";
import { createGraceCheckState } from "../personas/confirming-signal.js";
import type { ElderlyCareInput } from "../personas/evaluators.js";
import type { HouseholdProfileView } from "./attribution.js";
import {
  createCoLivingConfirmationGate,
  createNoopCoLivingConfirmationGate,
  type CoLivingContext,
} from "./rhythm-gate.js";

const PROFILE: HouseholdProfileView = {
  householdName: "Rao residence",
  anchorIds: ["a1", "a2"],
  sharedWifiBssids: ["aa:bb:cc:dd:ee:ff"],
  sharedMediaDeviceIds: ["chromecast-living-room"],
};

const fakePrisma = {} as unknown as PrismaClient;
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: ProcessorContext = { prisma: fakePrisma, logger: silentLogger };

function job(name: string, data: unknown): Job {
  return { name, data } as unknown as Job;
}

function elderly(overrides: Partial<ElderlyCareInput> = {}): ElderlyCareInput {
  return {
    mean: 420,
    stdDev: 0,
    isWeekend: false,
    priorDaySteps: 0,
    avgStep30d: 0,
    nowMinuteOfDay: 900, // past deadline ⇒ would escalate absent confirmation
    routineConfirmed: false,
    ...overrides,
  };
}

function makeDeps(coLivingGate?: RhythmEvalDeps["coLivingGate"]) {
  const store = createInMemoryGraceCheckStore();
  const enqueueGraceCheck = vi.fn().mockResolvedValue(undefined);
  const openIncident = vi.fn().mockResolvedValue(undefined);
  const deps: RhythmEvalDeps = {
    store,
    enqueueGraceCheck,
    openIncident,
    coLivingGate,
  };
  return { store, openIncident, deps };
}

function seedPending(store: ReturnType<typeof createInMemoryGraceCheckStore>) {
  // deadline in the past ⇒ no confirming signal recorded ⇒ unconfirmed state.
  store.set(
    createGraceCheckState({ anchorId: "a1", serviceDay: "2025-01-31", deadline: 1 }),
  );
}

const graceData = (): GraceCheckJobData => ({
  anchorId: "a1",
  serviceDay: "2025-01-31",
  enabledModes: ["ELDERLY_CARE"],
  personaInputs: { ELDERLY_CARE: elderly() },
});

describe("createCoLivingConfirmationGate — pure gate (R35.2)", () => {
  const gateFor = (ctxValue: CoLivingContext | null) =>
    createCoLivingConfirmationGate(() => ctxValue);

  it("confirms a non-independent Anchor from a shared household ghost signal", async () => {
    const gate = gateFor({
      profile: PROFILE,
      requiresIndependentConfirmation: false,
      ghostSignals: [
        { signalType: "MEDIA_DEVICE_WAKE", source: "chromecast-living-room" },
      ],
      confirmingSignals: [],
    });
    await expect(gate.isRoutineConfirmed("a1", "2025-01-31")).resolves.toBe(true);
  });

  it("does NOT confirm an independent-confirmation Anchor from a household signal alone (R35.2)", async () => {
    const gate = gateFor({
      profile: PROFILE,
      requiresIndependentConfirmation: true,
      ghostSignals: [
        { signalType: "HOME_WIFI_REASSOCIATION", source: "aa:bb:cc:dd:ee:ff" },
      ],
      confirmingSignals: [],
    });
    await expect(gate.isRoutineConfirmed("a1", "2025-01-31")).resolves.toBe(false);
  });

  it("DOES confirm an independent-confirmation Anchor from its own screen unlock (R35.2)", async () => {
    const gate = gateFor({
      profile: PROFILE,
      requiresIndependentConfirmation: true,
      ghostSignals: [
        { signalType: "MEDIA_DEVICE_WAKE", source: "chromecast-living-room" },
      ],
      confirmingSignals: [{ type: "screen_unlock", at: 1 }],
    });
    await expect(gate.isRoutineConfirmed("a1", "2025-01-31")).resolves.toBe(true);
  });

  it("reports false for a non-co-living Anchor (null context ⇒ no override)", async () => {
    const gate = gateFor(null);
    await expect(gate.isRoutineConfirmed("solo", "2025-01-31")).resolves.toBe(
      false,
    );
  });
});

describe("rhythm-eval wiring: co-living household signal (R35.2)", () => {
  it("a shared household ghost signal WITHHOLDS escalation for a non-independent Anchor", async () => {
    const gate = createCoLivingConfirmationGate(() => ({
      profile: PROFILE,
      requiresIndependentConfirmation: false,
      ghostSignals: [
        { signalType: "MEDIA_DEVICE_WAKE", source: "chromecast-living-room" },
      ],
      confirmingSignals: [],
    }));
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
    };

    expect(result.escalated).toBe(false);
    expect(openIncident).not.toHaveBeenCalled();
  });

  it("a household signal ALONE does NOT withhold escalation for an independent-confirmation Anchor (R35.2)", async () => {
    const gate = createCoLivingConfirmationGate(() => ({
      profile: PROFILE,
      requiresIndependentConfirmation: true,
      ghostSignals: [
        { signalType: "MEDIA_DEVICE_WAKE", source: "chromecast-living-room" },
      ],
      confirmingSignals: [],
    }));
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
    };

    // No individual confirmation ⇒ the incident still opens.
    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("an individual screen unlock WITHHOLDS escalation for an independent-confirmation Anchor (R35.2)", async () => {
    const gate = createCoLivingConfirmationGate(() => ({
      profile: PROFILE,
      requiresIndependentConfirmation: true,
      ghostSignals: [
        { signalType: "MEDIA_DEVICE_WAKE", source: "chromecast-living-room" },
      ],
      confirmingSignals: [{ type: "step_delta", at: 1, stepDelta: 9 }],
    }));
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
    };

    expect(result.escalated).toBe(false);
    expect(openIncident).not.toHaveBeenCalled();
  });
});

describe("rhythm-eval wiring: backwards-compatible & additive", () => {
  it("without a co-living gate, behaviour is unchanged (opens incident)", async () => {
    const { store, openIncident, deps } = makeDeps(undefined);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
    };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("a no-op gate never overrides confirmation", async () => {
    const { store, openIncident, deps } = makeDeps(
      createNoopCoLivingConfirmationGate(),
    );
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
    };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("the gate is NOT consulted when the state is already confirmed (additive-only)", async () => {
    const lookup = vi.fn(() => null);
    const gate = createCoLivingConfirmationGate(lookup);
    const { store, openIncident, deps } = makeDeps(gate);
    // Confirmed state (deadline in the future + a confirming signal folded in
    // would set confirmed; here we set confirmed directly via the store shape).
    store.set({
      anchorId: "a1",
      serviceDay: "2025-01-31",
      deadline: 1,
      confirmed: true,
    });
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(job("grace-check", graceData()), ctx)) as {
      escalated: boolean;
    };

    expect(result.escalated).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(openIncident).not.toHaveBeenCalled();
  });
});
