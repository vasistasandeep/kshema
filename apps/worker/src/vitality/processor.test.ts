import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Job } from "bullmq";
import type { PrismaClient } from "@kshema/database";

import type { ProcessorContext } from "../jobs/registry.js";
import type { VitalityPulse } from "./pulse.js";
import { emptyStreakState, type StreakState } from "./streak.js";
import {
  createVitalityProcessor,
  type VitalityProcessorDeps,
} from "./processor.js";

const fakePrisma = {} as unknown as PrismaClient;
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: ProcessorContext = { prisma: fakePrisma, logger: silentLogger };

function job(name: string, data: unknown): Job {
  return { name, data } as unknown as Job;
}

// 2025-01-31 01:15 UTC == 06:45 IST on 2025-01-31.
const CONFIRMED_AT = Date.UTC(2025, 0, 31, 1, 15, 0);

function makeDeps(initialStreak?: StreakState) {
  const streaks = new Map<string, StreakState>();
  if (initialStreak) streaks.set("circle-1", initialStreak);
  const delivered: VitalityPulse[] = [];
  const logs: unknown[] = [];

  const deps: VitalityProcessorDeps = {
    now: () => CONFIRMED_AT,
    loadAnchorProfile: vi.fn(async (anchorId) => ({
      anchorId,
      preferredName: "Amma",
      timezone: "Asia/Kolkata",
    })),
    listObservers: vi.fn(async () => [
      { observerId: "obs-1", pushTokens: ["t1"] },
      { observerId: "obs-2", pushTokens: ["t2"] },
    ]),
    recordPulseLog: vi.fn(async (input) => {
      logs.push(input);
    }),
    deliverPulse: vi.fn(async (pulse) => {
      delivered.push(pulse);
    }),
    loadStreak: vi.fn(async (circleId) => streaks.get(circleId) ?? emptyStreakState()),
    saveStreak: vi.fn(async (circleId, state) => {
      streaks.set(circleId, state);
    }),
    resolveTimezone: vi.fn(async () => "Asia/Kolkata"),
  };
  return { deps, streaks, delivered, logs };
}

describe("createVitalityProcessor — pulse job (R7 + R22.2)", () => {
  it("emits a pulse per Observer and increments the streak once for the day", async () => {
    const { deps, streaks, delivered } = makeDeps();
    const processor = createVitalityProcessor(deps);

    const res = (await processor(
      job("pulse", {
        circleId: "circle-1",
        anchorId: "anchor-1",
        confirmedAtMillis: CONFIRMED_AT,
        context: { steps: 400, weather: "26C" },
      }),
      ctx,
    )) as { pulses: number; logged: boolean; streakCount: number; incremented: boolean; day: string };

    expect(res.pulses).toBe(2);
    expect(res.logged).toBe(true);
    expect(res.incremented).toBe(true);
    expect(res.streakCount).toBe(1);
    expect(res.day).toBe("2025-01-31");
    expect(delivered).toHaveLength(2);
    expect(delivered[0]!.anchorPreferredName).toBe("Amma");
    expect(delivered[0]!.confirmationTimeLocal).toBe("06:45");
    expect(deps.recordPulseLog).toHaveBeenCalledTimes(1);
    expect(streaks.get("circle-1")!.count).toBe(1);
  });

  it("does not double-increment the streak for a second pulse on the same day", async () => {
    const { deps, streaks } = makeDeps();
    const processor = createVitalityProcessor(deps);
    const args = job("pulse", {
      circleId: "circle-1",
      anchorId: "anchor-1",
      confirmedAtMillis: CONFIRMED_AT,
    });
    await processor(args, ctx);
    const second = (await processor(args, ctx)) as { streakCount: number; incremented: boolean };
    expect(second.incremented).toBe(false);
    expect(second.streakCount).toBe(1);
    expect(streaks.get("circle-1")!.count).toBe(1);
    // saveStreak only persisted once (the first, real increment).
    expect(deps.saveStreak).toHaveBeenCalledTimes(1);
  });
});

describe("createVitalityProcessor — preserve job (R22.4)", () => {
  it("preserves the streak on a delayed / no-crisis resolution", async () => {
    const { deps } = makeDeps({ count: 9, lastConfirmedDay: "2025-01-30", freezeUntil: null });
    const processor = createVitalityProcessor(deps);
    const res = (await processor(job("preserve", { circleId: "circle-1" }), ctx)) as {
      preserved: boolean;
      streakCount: number;
    };
    expect(res.preserved).toBe(true);
    expect(res.streakCount).toBe(9); // unchanged
  });
});

describe("createVitalityProcessor — freeze job (R22.5)", () => {
  it("applies a Streak_Freeze of up to 3 days without changing the count", async () => {
    const { deps, streaks } = makeDeps({ count: 4, lastConfirmedDay: "2025-01-30", freezeUntil: null });
    const processor = createVitalityProcessor(deps);
    const res = (await processor(
      job("freeze", { circleId: "circle-1", anchorId: "anchor-1", days: 3, atMillis: CONFIRMED_AT }),
      ctx,
    )) as { frozen: boolean; streakCount: number; freezeUntil: string | null };

    expect(res.frozen).toBe(true);
    expect(res.streakCount).toBe(4);
    // start day 2025-01-31, 3-day freeze → last frozen day 2025-02-02.
    expect(res.freezeUntil).toBe("2025-02-02");
    expect(streaks.get("circle-1")!.freezeUntil).toBe("2025-02-02");
  });

  it("clamps an over-large freeze request to 3 days", async () => {
    const { deps } = makeDeps();
    const processor = createVitalityProcessor(deps);
    const res = (await processor(
      job("freeze", { circleId: "circle-1", anchorId: "anchor-1", days: 30, atMillis: CONFIRMED_AT }),
      ctx,
    )) as { freezeUntil: string | null };
    expect(res.freezeUntil).toBe("2025-02-02");
  });
});

/**
 * R22.6 STRUCTURAL INVARIANT: the vitality module can NEVER open a
 * Safety_Incident or trigger escalation. We verify this two ways:
 *   1. behaviorally — no dep is an incident/escalation seam, and there is no
 *      way to make the processor call one (there is none in its deps);
 *   2. structurally — the vitality source files never import the escalation
 *      queue, an escalation processor, or reference an `openIncident` seam.
 */
describe("createVitalityProcessor — R22.6 no incident/escalation path", () => {
  it("exposes no incident/escalation seam on its dependency contract", () => {
    const { deps } = makeDeps();
    const depKeys = Object.keys(deps);
    for (const key of depKeys) {
      expect(key.toLowerCase()).not.toContain("incident");
      expect(key.toLowerCase()).not.toContain("escalat");
      expect(key.toLowerCase()).not.toContain("sos");
    }
  });

  it("never invokes an incident-opening side effect during any job kind", async () => {
    const { deps } = makeDeps();
    const openIncident = vi.fn();
    // Attach a would-be escalation seam; the processor has no way to reach it.
    (deps as unknown as Record<string, unknown>).openIncident = openIncident;
    const processor = createVitalityProcessor(deps);

    await processor(
      job("pulse", { circleId: "circle-1", anchorId: "anchor-1", confirmedAtMillis: CONFIRMED_AT }),
      ctx,
    );
    await processor(job("preserve", { circleId: "circle-1" }), ctx);
    await processor(
      job("freeze", { circleId: "circle-1", anchorId: "anchor-1", days: 3 }),
      ctx,
    );

    expect(openIncident).not.toHaveBeenCalled();
  });

  it("no vitality source file imports the escalation path or an openIncident seam", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = ["streak.ts", "pulse.ts", "processor.ts"];
    // Strip comments so we assert on actual CODE, not the R22.6 prose in the
    // doc-comments (which deliberately mention "openIncident"/"Safety_Incident"
    // to explain what is *absent*).
    const stripComments = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
        .replace(/\/\/[^\n]*/g, ""); // line comments
    for (const file of sources) {
      const code = stripComments(readFileSync(join(here, file), "utf8"));
      // Must not import from the escalation/resolution modules...
      expect(code).not.toMatch(/from\s+["'][^"']*escalation/);
      expect(code).not.toMatch(/from\s+["'][^"']*resolution/);
      // ...nor reference an incident-open seam or SafetyIncident type in code.
      expect(code).not.toMatch(/openIncident/);
      expect(code).not.toMatch(/SafetyIncident/);
    }
  });
});
