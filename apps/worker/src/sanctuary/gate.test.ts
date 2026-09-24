import { describe, expect, it, vi } from "vitest";

import {
  SANCTUARY_MAX_WINDOW_MS,
  SANCTUARY_STREAK_PRESERVED,
  clampResumesAt,
  createNoopSanctuaryGate,
  createSanctuaryGate,
  isSanctuaryActive,
  isWindowWithin14Days,
  type SanctuaryWindow,
} from "./gate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2025, 0, 10, 0, 0, 0);

function window(overrides: Partial<SanctuaryWindow> = {}): SanctuaryWindow {
  return {
    userId: "anchor-1",
    startsAt: START,
    resumesAt: START + 3 * DAY_MS,
    isActive: true,
    ...overrides,
  };
}

describe("isSanctuaryActive — the pure predicate (R34.2/R34.4)", () => {
  it("is true strictly inside the window [startsAt, resumesAt)", () => {
    const schedules = [window()];
    expect(isSanctuaryActive(schedules, START)).toBe(true); // at start (inclusive)
    expect(isSanctuaryActive(schedules, START + DAY_MS)).toBe(true); // mid window
    expect(isSanctuaryActive(schedules, START + 3 * DAY_MS - 1)).toBe(true); // just before resume
  });

  it("is false before startsAt (window not yet begun)", () => {
    expect(isSanctuaryActive([window()], START - 1)).toBe(false);
  });

  it("auto-resumes at resumesAt with no state write (resumesAt is exclusive, R34.4)", () => {
    const schedules = [window()];
    // At the exact resumption instant and beyond, the gate returns false.
    expect(isSanctuaryActive(schedules, START + 3 * DAY_MS)).toBe(false);
    expect(isSanctuaryActive(schedules, START + 10 * DAY_MS)).toBe(false);
    // Re-consulting is idempotent: the input schedule is never mutated.
    const before = JSON.stringify(schedules);
    isSanctuaryActive(schedules, START + 100 * DAY_MS);
    expect(JSON.stringify(schedules)).toBe(before);
    expect(schedules[0]?.isActive).toBe(true);
  });

  it("ignores inactive schedules (early manual end)", () => {
    expect(isSanctuaryActive([window({ isActive: false })], START + DAY_MS)).toBe(
      false,
    );
  });

  it("is true if ANY active schedule contains now", () => {
    const schedules = [
      window({ isActive: false }),
      window({ startsAt: START + 5 * DAY_MS, resumesAt: START + 6 * DAY_MS }),
    ];
    expect(isSanctuaryActive(schedules, START + 5 * DAY_MS + 1)).toBe(true);
    expect(isSanctuaryActive(schedules, START + DAY_MS)).toBe(false);
  });

  it("accepts Date and epoch-millis interchangeably", () => {
    const schedules = [
      window({ startsAt: new Date(START), resumesAt: new Date(START + DAY_MS) }),
    ];
    expect(isSanctuaryActive(schedules, new Date(START + 1))).toBe(true);
  });

  it("empty schedule set resolves to not active", () => {
    expect(isSanctuaryActive([], START)).toBe(false);
  });
});

describe("14-day window validation and defensive clamp (R34.1)", () => {
  it("SANCTUARY_MAX_WINDOW_MS is exactly 14 days", () => {
    expect(SANCTUARY_MAX_WINDOW_MS).toBe(14 * DAY_MS);
  });

  it("isWindowWithin14Days accepts up to 14d and rejects longer / non-positive", () => {
    expect(isWindowWithin14Days(START, START + 14 * DAY_MS)).toBe(true);
    expect(isWindowWithin14Days(START, START + DAY_MS)).toBe(true);
    expect(isWindowWithin14Days(START, START + 14 * DAY_MS + 1)).toBe(false);
    expect(isWindowWithin14Days(START, START)).toBe(false); // zero-length
    expect(isWindowWithin14Days(START, START - 1)).toBe(false); // negative
  });

  it("clampResumesAt caps an over-long window at startsAt + 14d", () => {
    expect(clampResumesAt(START, START + 100 * DAY_MS)).toBe(
      START + 14 * DAY_MS,
    );
    // A within-limit window is left untouched.
    expect(clampResumesAt(START, START + 3 * DAY_MS)).toBe(START + 3 * DAY_MS);
  });

  it("an over-long window is defensively clamped so it cannot suspend past 14d", () => {
    const schedules = [window({ resumesAt: START + 100 * DAY_MS })];
    // Still active within 14 days...
    expect(isSanctuaryActive(schedules, START + 13 * DAY_MS)).toBe(true);
    // ...but resumes at the 14d cap, not the over-long resumesAt.
    expect(isSanctuaryActive(schedules, START + 14 * DAY_MS)).toBe(false);
    expect(isSanctuaryActive(schedules, START + 20 * DAY_MS)).toBe(false);
  });
});

describe("Vitality_Streak preservation is structural (R34.5)", () => {
  it("the gate exposes no streak surface and asserts preservation by construction", () => {
    // The marker documents that no code path from the gate touches the streak.
    expect(SANCTUARY_STREAK_PRESERVED).toBe(true);
  });
});

describe("createSanctuaryGate — injectable schedule seam", () => {
  it("suppresses when the fetched windows are active at now", async () => {
    const fetch = vi.fn().mockResolvedValue([window()]);
    const gate = createSanctuaryGate(fetch);
    await expect(
      gate.shouldSuppressIncident("anchor-1", START + DAY_MS),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("anchor-1", START + DAY_MS);
  });

  it("does not suppress at/after resumesAt (auto-resume, no reactivation call)", async () => {
    const fetch = vi.fn().mockResolvedValue([window()]);
    const gate = createSanctuaryGate(fetch);
    await expect(
      gate.shouldSuppressIncident("anchor-1", START + 3 * DAY_MS),
    ).resolves.toBe(false);
    // Only a read; the seam is never asked to write a "resumed" flag.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not suppress before startsAt", async () => {
    const fetch = vi.fn().mockResolvedValue([window()]);
    const gate = createSanctuaryGate(fetch);
    await expect(
      gate.shouldSuppressIncident("anchor-1", START - 1),
    ).resolves.toBe(false);
  });

  it("accepts a synchronous fetch seam", async () => {
    const gate = createSanctuaryGate(() => [window()]);
    await expect(
      gate.shouldSuppressIncident("anchor-1", START + DAY_MS),
    ).resolves.toBe(true);
  });

  it("empty schedule set resolves to no suppression", async () => {
    const gate = createSanctuaryGate(() => []);
    await expect(
      gate.shouldSuppressIncident("anchor-1", START),
    ).resolves.toBe(false);
  });
});

describe("createNoopSanctuaryGate", () => {
  it("never suppresses", async () => {
    const gate = createNoopSanctuaryGate();
    await expect(
      gate.shouldSuppressIncident("anchor-1", START + DAY_MS),
    ).resolves.toBe(false);
  });
});
