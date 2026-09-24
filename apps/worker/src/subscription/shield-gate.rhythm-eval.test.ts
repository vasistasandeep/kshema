/**
 * Integration tests for wiring the Shield_Paused gate into the rhythm-eval
 * routine grace-check incident-open decision (R20.2/R20.3/R20.5).
 *
 * These live under `subscription/` (rather than in `personas/rhythm-eval.test.ts`)
 * because tasks 13.7/16.3/17.3 may edit that file concurrently; keeping the
 * Shield wiring assertions here avoids a save conflict while still exercising
 * the real processor.
 */
import { describe, expect, it, vi } from "vitest";

import type { Job } from "bullmq";
import type { PrismaClient, SubscriptionTier } from "@kshema/database";

import type { ProcessorContext } from "../jobs/registry.js";
import {
  createInMemoryGraceCheckStore,
  createRhythmEvalProcessor,
  type GraceCheckJobData,
  type RhythmEvalDeps,
} from "../personas/rhythm-eval.js";
import { createGraceCheckState } from "../personas/confirming-signal.js";
import type { ElderlyCareInput } from "../personas/evaluators.js";
import { createShieldGate, createNoopShieldGate } from "./shield-gate.js";

const TRIAL = "TRIAL" as SubscriptionTier;
const PRO = "PRO" as SubscriptionTier;
const SHIELD_PAUSED = "SHIELD_PAUSED" as SubscriptionTier;

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
    nowMinuteOfDay: 900, // past deadline ⇒ would escalate absent a gate
    routineConfirmed: false,
    ...overrides,
  };
}

function makeDeps(shieldGate?: RhythmEvalDeps["shieldGate"]) {
  const store = createInMemoryGraceCheckStore();
  const enqueueGraceCheck = vi.fn().mockResolvedValue(undefined);
  const openIncident = vi.fn().mockResolvedValue(undefined);
  const deps: RhythmEvalDeps = {
    store,
    enqueueGraceCheck,
    openIncident,
    shieldGate,
  };
  return { store, openIncident, deps };
}

function seedPending(store: ReturnType<typeof createInMemoryGraceCheckStore>) {
  store.set(
    createGraceCheckState({
      anchorId: "a1",
      serviceDay: "2025-01-31",
      deadline: 1000,
    }),
  );
}

/** A routine grace-check carrying a circleId so the shield gate is reachable. */
const routineGraceData = (): GraceCheckJobData => ({
  anchorId: "a1",
  serviceDay: "2025-01-31",
  circleId: "circle-1",
  enabledModes: ["ELDERLY_CARE"],
  personaInputs: { ELDERLY_CARE: elderly() },
});

describe("Shield_Paused suppresses the routine grace-check (R20.5)", () => {
  it("SHIELD_PAUSED suppresses a routine grace-check incident-open — no incident opens", async () => {
    const gate = createShieldGate(() => SHIELD_PAUSED);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", routineGraceData()),
      ctx,
    )) as { escalated: boolean; suppressedBy?: string };

    expect(result.escalated).toBe(false);
    expect(result.suppressedBy).toBe("shield_paused");
    expect(openIncident).not.toHaveBeenCalled();
  });
});

describe("TRIAL and PRO keep full capabilities (R20.2/R20.3)", () => {
  it("TRIAL does NOT suppress — routine incident opens normally", async () => {
    const gate = createShieldGate(() => TRIAL);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", routineGraceData()),
      ctx,
    )) as { escalated: boolean };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("PRO does NOT suppress — routine incident opens normally", async () => {
    const gate = createShieldGate(() => PRO);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", routineGraceData()),
      ctx,
    )) as { escalated: boolean };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });
});

describe("emergency paths are NEVER suppressed by the Shield gate (R20.3/R20.5)", () => {
  it("STRUCTURAL: a routine job WITHOUT a circleId never consults the gate", async () => {
    // Shadow_SOS, acoustic-distress, and hardware-duress incidents are opened on
    // the resolution/SOS path (events/consumers.ts), which never carries a
    // Shield-gate consult and never passes a circleId here. We model that here:
    // a grace-check job with no circleId must never reach the gate, so even a
    // SHIELD_PAUSED tier cannot suppress it.
    const lookup = vi.fn(() => SHIELD_PAUSED);
    const gate = createShieldGate(lookup);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const dataNoCircle: GraceCheckJobData = {
      anchorId: "a1",
      serviceDay: "2025-01-31",
      // circleId intentionally omitted — models a non-routine entry point
      enabledModes: ["ELDERLY_CARE"],
      personaInputs: { ELDERLY_CARE: elderly() },
    };

    const result = (await process(job("grace-check", dataNoCircle), ctx)) as {
      escalated: boolean;
    };

    // The tier lookup was never consulted, and the incident proceeded.
    expect(lookup).not.toHaveBeenCalled();
    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("the Shield gate is only consulted when evaluation would otherwise escalate", async () => {
    // A confirmed routine already withholds escalation; the gate must not even
    // be consulted (mirrors the Sanctuary ordering).
    const lookup = vi.fn(() => SHIELD_PAUSED);
    const gate = createShieldGate(lookup);
    const { store, openIncident, deps } = makeDeps(gate);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    // Not-yet-past deadline ⇒ evaluator does not trigger ⇒ canEscalate false.
    const nonEscalating: GraceCheckJobData = {
      ...routineGraceData(),
      personaInputs: { ELDERLY_CARE: elderly({ nowMinuteOfDay: 100 }) },
    };

    const result = (await process(job("grace-check", nonEscalating), ctx)) as {
      escalated: boolean;
    };

    expect(result.escalated).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(openIncident).not.toHaveBeenCalled();
  });
});

describe("tier-lookup seam is injectable and backwards-compatible", () => {
  it("without a shield gate configured, behaviour is unchanged (opens incident)", async () => {
    const { store, openIncident, deps } = makeDeps(undefined);
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", routineGraceData()),
      ctx,
    )) as { escalated: boolean };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("a no-op gate never suppresses even with a circleId present", async () => {
    const { store, openIncident, deps } = makeDeps(createNoopShieldGate());
    seedPending(store);
    const process = createRhythmEvalProcessor(deps);

    const result = (await process(
      job("grace-check", routineGraceData()),
      ctx,
    )) as { escalated: boolean };

    expect(result.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });

  it("resumes automatically after SHIELD_PAUSED→PRO across consecutive checks", async () => {
    const lookup = vi
      .fn(() => SHIELD_PAUSED)
      .mockReturnValueOnce(SHIELD_PAUSED)
      .mockReturnValueOnce(PRO);
    const gate = createShieldGate(lookup);
    const { store, openIncident, deps } = makeDeps(gate);
    const process = createRhythmEvalProcessor(deps);

    seedPending(store);
    const first = (await process(
      job("grace-check", routineGraceData()),
      ctx,
    )) as { escalated: boolean };
    expect(first.escalated).toBe(false);

    seedPending(store);
    const second = (await process(
      job("grace-check", routineGraceData()),
      ctx,
    )) as { escalated: boolean };
    expect(second.escalated).toBe(true);
    expect(openIncident).toHaveBeenCalledTimes(1);
  });
});
