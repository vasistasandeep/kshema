import { describe, expect, it, vi } from "vitest";

import {
  BEDTIME_CHIME_MESSAGE,
  BEDTIME_LOW_THRESHOLD,
  LIKELY_BATTERY_DEPLETION_LABEL,
  PRE_DAWN_EXHAUSTION_THRESHOLD,
  type BatteryGuardianDeps,
  type DocumentedWarning,
  type MorningIncidentFlagDeps,
  type PreDawnWindow,
  evaluateBatteryGuardian,
  flagMorningIncidentIfBatteryDepleted,
  hasDocumentedPreDawnWarning,
  runBatteryGuardian,
} from "./guardian.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NIGHT_START = Date.UTC(2025, 0, 10, 22, 0, 0); // 22:00
const PRE_DAWN: PreDawnWindow = {
  start: NIGHT_START,
  end: NIGHT_START + 8 * 60 * 60 * 1000, // through 06:00
};

describe("evaluateBatteryGuardian — bedtime chime (R32.2)", () => {
  it("emits chime + BEDTIME_LOW iff BEDTIME_MINUS_60, battery < 25, unplugged", () => {
    const d = evaluateBatteryGuardian({
      phase: "BEDTIME_MINUS_60",
      batteryLevel: 24,
      chargerState: "UNPLUGGED",
    });
    expect(d.action).toBe("bedtime_chime");
    expect(d.chime).toBe(true);
    expect(d.logKind).toBe("BEDTIME_LOW");
    expect(d.notifyObserver).toBe(false);
  });

  it("does NOT fire at exactly 25% (strict threshold)", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "BEDTIME_MINUS_60",
        batteryLevel: BEDTIME_LOW_THRESHOLD,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");
  });

  it("does NOT fire above threshold", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "BEDTIME_MINUS_60",
        batteryLevel: 60,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");
  });

  it("does NOT fire when plugged in even below threshold", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "BEDTIME_MINUS_60",
        batteryLevel: 5,
        chargerState: "PLUGGED",
      }).action,
    ).toBe("none");
  });

  it("fires at 0% unplugged (lower boundary)", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "BEDTIME_MINUS_60",
        batteryLevel: 0,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("bedtime_chime");
  });
});

describe("evaluateBatteryGuardian — pre-dawn warning (R32.3)", () => {
  it("logs PRE_DAWN warning + notifies iff POST_MIDNIGHT, battery < 15, unplugged", () => {
    const d = evaluateBatteryGuardian({
      phase: "POST_MIDNIGHT",
      batteryLevel: 14,
      chargerState: "UNPLUGGED",
    });
    expect(d.action).toBe("pre_dawn_warning");
    expect(d.chime).toBe(false);
    expect(d.logKind).toBe("PRE_DAWN_BATTERY_EXHAUSTION_WARNING");
    expect(d.notifyObserver).toBe(true);
  });

  it("does NOT fire at exactly 15% (strict threshold)", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "POST_MIDNIGHT",
        batteryLevel: PRE_DAWN_EXHAUSTION_THRESHOLD,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");
  });

  it("does NOT fire when plugged in", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "POST_MIDNIGHT",
        batteryLevel: 3,
        chargerState: "PLUGGED",
      }).action,
    ).toBe("none");
  });

  it("does NOT fire above threshold", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "POST_MIDNIGHT",
        batteryLevel: 20,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");
  });
});

describe("evaluateBatteryGuardian — phase gating", () => {
  it("BEDTIME_MINUS_60 threshold (25) does NOT trip the pre-dawn (15) path", () => {
    // 20% at bedtime -> chime; 20% post-midnight -> none (above 15).
    expect(
      evaluateBatteryGuardian({
        phase: "BEDTIME_MINUS_60",
        batteryLevel: 20,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("bedtime_chime");
    expect(
      evaluateBatteryGuardian({
        phase: "POST_MIDNIGHT",
        batteryLevel: 20,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");
  });

  it("an unrelated phase never triggers an action", () => {
    expect(
      evaluateBatteryGuardian({
        phase: "MIDDAY",
        batteryLevel: 1,
        chargerState: "UNPLUGGED",
      }).action,
    ).toBe("none");
  });

  it("does not mutate its input", () => {
    const reading = {
      phase: "BEDTIME_MINUS_60" as const,
      batteryLevel: 10,
      chargerState: "UNPLUGGED" as const,
    };
    const before = JSON.stringify(reading);
    evaluateBatteryGuardian(reading);
    expect(JSON.stringify(reading)).toBe(before);
  });
});

function makeDeps(): BatteryGuardianDeps & {
  emitChime: ReturnType<typeof vi.fn>;
  writeWarningLog: ReturnType<typeof vi.fn>;
  notifyObserverDashboard: ReturnType<typeof vi.fn>;
} {
  return {
    emitChime: vi.fn().mockResolvedValue(undefined),
    writeWarningLog: vi.fn().mockResolvedValue(undefined),
    notifyObserverDashboard: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runBatteryGuardian — effect seams (R32.2/R32.3)", () => {
  it("bedtime path emits chime and writes BEDTIME_LOW, no observer notify", async () => {
    const deps = makeDeps();
    const res = await runBatteryGuardian(deps, {
      userId: "anchor-1",
      reading: { phase: "BEDTIME_MINUS_60", batteryLevel: 10, chargerState: "UNPLUGGED" },
    });
    expect(res.chimed).toBe(true);
    expect(res.logged).toBe(true);
    expect(res.notified).toBe(false);
    expect(deps.emitChime).toHaveBeenCalledWith({
      userId: "anchor-1",
      message: BEDTIME_CHIME_MESSAGE,
    });
    expect(deps.writeWarningLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "anchor-1",
        kind: "BEDTIME_LOW",
        batteryLevel: 10,
        chargerState: "UNPLUGGED",
      }),
    );
    expect(deps.notifyObserverDashboard).not.toHaveBeenCalled();
  });

  it("pre-dawn path writes PRE_DAWN warning + notifies observer, no chime", async () => {
    const deps = makeDeps();
    const res = await runBatteryGuardian(deps, {
      userId: "anchor-2",
      reading: { phase: "POST_MIDNIGHT", batteryLevel: 8, chargerState: "UNPLUGGED" },
    });
    expect(res.chimed).toBe(false);
    expect(res.logged).toBe(true);
    expect(res.notified).toBe(true);
    expect(deps.emitChime).not.toHaveBeenCalled();
    expect(deps.writeWarningLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "anchor-2",
        kind: "PRE_DAWN_BATTERY_EXHAUSTION_WARNING",
        batteryLevel: 8,
      }),
    );
    expect(deps.notifyObserverDashboard).toHaveBeenCalledWith({
      userId: "anchor-2",
      batteryLevel: 8,
    });
  });

  it("no-action path touches no seam", async () => {
    const deps = makeDeps();
    const res = await runBatteryGuardian(deps, {
      userId: "anchor-3",
      reading: { phase: "BEDTIME_MINUS_60", batteryLevel: 80, chargerState: "PLUGGED" },
    });
    expect(res).toEqual({
      decision: expect.objectContaining({ action: "none" }),
      chimed: false,
      logged: false,
      notified: false,
    });
    expect(deps.emitChime).not.toHaveBeenCalled();
    expect(deps.writeWarningLog).not.toHaveBeenCalled();
    expect(deps.notifyObserverDashboard).not.toHaveBeenCalled();
  });

  it("forwards an explicit loggedAt to the log write", async () => {
    const deps = makeDeps();
    const at = NIGHT_START + 60 * 60 * 1000;
    await runBatteryGuardian(deps, {
      userId: "anchor-4",
      reading: { phase: "POST_MIDNIGHT", batteryLevel: 5, chargerState: "UNPLUGGED" },
      loggedAt: at,
    });
    expect(deps.writeWarningLog).toHaveBeenCalledWith(
      expect.objectContaining({ loggedAt: at }),
    );
  });
});

describe("hasDocumentedPreDawnWarning — attribution predicate (R32.4)", () => {
  const preDawnWarning = (loggedAt: number): DocumentedWarning => ({
    kind: "PRE_DAWN_BATTERY_EXHAUSTION_WARNING",
    loggedAt,
  });

  it("true when a PRE_DAWN warning falls inside the window", () => {
    expect(
      hasDocumentedPreDawnWarning(
        [preDawnWarning(NIGHT_START + 60 * 60 * 1000)],
        PRE_DAWN,
      ),
    ).toBe(true);
  });

  it("false when there are no warnings", () => {
    expect(hasDocumentedPreDawnWarning([], PRE_DAWN)).toBe(false);
  });

  it("BEDTIME_LOW warnings do NOT qualify", () => {
    expect(
      hasDocumentedPreDawnWarning(
        [{ kind: "BEDTIME_LOW", loggedAt: NIGHT_START + 60 * 60 * 1000 }],
        PRE_DAWN,
      ),
    ).toBe(false);
  });

  it("a PRE_DAWN warning outside the window does NOT qualify", () => {
    // Before the window and at/after the exclusive end.
    expect(
      hasDocumentedPreDawnWarning([preDawnWarning(NIGHT_START - 1)], PRE_DAWN),
    ).toBe(false);
    expect(
      hasDocumentedPreDawnWarning(
        [preDawnWarning(toEnd(PRE_DAWN))],
        PRE_DAWN,
      ),
    ).toBe(false);
  });

  it("window start is inclusive, end is exclusive", () => {
    expect(
      hasDocumentedPreDawnWarning([preDawnWarning(NIGHT_START)], PRE_DAWN),
    ).toBe(true);
    expect(
      hasDocumentedPreDawnWarning([preDawnWarning(toEnd(PRE_DAWN) - 1)], PRE_DAWN),
    ).toBe(true);
  });
});

function toEnd(w: PreDawnWindow): number {
  return typeof w.end === "number" ? w.end : w.end.getTime();
}

function makeFlagDeps(
  warnings: readonly DocumentedWarning[],
): MorningIncidentFlagDeps & {
  fetchWarnings: ReturnType<typeof vi.fn>;
  flagIncident: ReturnType<typeof vi.fn>;
} {
  return {
    fetchWarnings: vi.fn().mockResolvedValue(warnings),
    flagIncident: vi.fn().mockResolvedValue(undefined),
  };
}

describe("flagMorningIncidentIfBatteryDepleted (R32.4)", () => {
  it("flags the STAGE_1 incident iff a documented pre-dawn warning exists", async () => {
    const deps = makeFlagDeps([
      { kind: "PRE_DAWN_BATTERY_EXHAUSTION_WARNING", loggedAt: NIGHT_START + 60 * 60 * 1000 },
    ]);
    const res = await flagMorningIncidentIfBatteryDepleted(deps, {
      userId: "anchor-1",
      incidentId: "incident-1",
      window: PRE_DAWN,
    });
    expect(res.flagged).toBe(true);
    expect(deps.flagIncident).toHaveBeenCalledWith({
      incidentId: "incident-1",
      label: LIKELY_BATTERY_DEPLETION_LABEL,
    });
  });

  it("does NOT flag when there is no documented pre-dawn warning", async () => {
    const deps = makeFlagDeps([]);
    const res = await flagMorningIncidentIfBatteryDepleted(deps, {
      userId: "anchor-2",
      incidentId: "incident-2",
      window: PRE_DAWN,
    });
    expect(res.flagged).toBe(false);
    expect(deps.flagIncident).not.toHaveBeenCalled();
  });

  it("does NOT flag when only a BEDTIME_LOW warning exists", async () => {
    const deps = makeFlagDeps([
      { kind: "BEDTIME_LOW", loggedAt: NIGHT_START + 60 * 60 * 1000 },
    ]);
    const res = await flagMorningIncidentIfBatteryDepleted(deps, {
      userId: "anchor-3",
      incidentId: "incident-3",
      window: PRE_DAWN,
    });
    expect(res.flagged).toBe(false);
    expect(deps.flagIncident).not.toHaveBeenCalled();
  });

  it("does NOT flag when the pre-dawn warning is outside the window", async () => {
    const deps = makeFlagDeps([
      { kind: "PRE_DAWN_BATTERY_EXHAUSTION_WARNING", loggedAt: NIGHT_START - DAY_MS },
    ]);
    const res = await flagMorningIncidentIfBatteryDepleted(deps, {
      userId: "anchor-4",
      incidentId: "incident-4",
      window: PRE_DAWN,
    });
    expect(res.flagged).toBe(false);
    expect(deps.flagIncident).not.toHaveBeenCalled();
  });
});
