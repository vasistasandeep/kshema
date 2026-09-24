import { describe, expect, it } from "vitest";

import {
  addDays,
  applyStreakFreeze,
  compareDays,
  emptyStreakState,
  incrementStreak,
  isFrozen,
  MAX_STREAK_FREEZE_DAYS,
  preserveStreak,
  resolveUnconfirmedDay,
  serviceDayInTimezone,
} from "./streak.js";

describe("serviceDayInTimezone (R22 day key)", () => {
  it("renders yyyy-mm-dd in the Anchor timezone", () => {
    // 2025-01-31 20:00 UTC is 2025-02-01 01:30 in Asia/Kolkata (+5:30).
    const at = Date.UTC(2025, 0, 31, 20, 0, 0);
    expect(serviceDayInTimezone(at, "Asia/Kolkata")).toBe("2025-02-01");
    expect(serviceDayInTimezone(at, "UTC")).toBe("2025-01-31");
  });
});

describe("addDays / compareDays", () => {
  it("adds whole calendar days across month boundaries", () => {
    expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    expect(addDays("2025-03-01", -1)).toBe("2025-02-28");
    expect(addDays("2025-01-01", 0)).toBe("2025-01-01");
  });

  it("orders day strings chronologically", () => {
    expect(compareDays("2025-01-01", "2025-01-02")).toBeLessThan(0);
    expect(compareDays("2025-02-01", "2025-01-31")).toBeGreaterThan(0);
    expect(compareDays("2025-01-01", "2025-01-01")).toBe(0);
  });
});

describe("incrementStreak (R22.2 — idempotent per day)", () => {
  it("increments by one for a confirmed morning", () => {
    const { state, incremented } = incrementStreak(emptyStreakState(), "2025-01-01");
    expect(incremented).toBe(true);
    expect(state.count).toBe(1);
    expect(state.lastConfirmedDay).toBe("2025-01-01");
  });

  it("does NOT double-increment for the same day (idempotent)", () => {
    const first = incrementStreak(emptyStreakState(), "2025-01-01");
    const second = incrementStreak(first.state, "2025-01-01");
    expect(second.incremented).toBe(false);
    expect(second.state.count).toBe(1);
    expect(second.state).toBe(first.state); // unchanged reference
  });

  it("increments across consecutive distinct days", () => {
    let s = emptyStreakState();
    s = incrementStreak(s, "2025-01-01").state;
    s = incrementStreak(s, "2025-01-02").state;
    s = incrementStreak(s, "2025-01-03").state;
    expect(s.count).toBe(3);
    expect(s.lastConfirmedDay).toBe("2025-01-03");
  });
});

describe("preserveStreak (R22.4 — delayed / no-crisis resolution)", () => {
  it("leaves the streak unchanged (neither increment nor reset)", () => {
    const s = { count: 7, lastConfirmedDay: "2025-01-07", freezeUntil: null };
    expect(preserveStreak(s)).toBe(s);
    expect(preserveStreak(s).count).toBe(7);
  });
});

describe("applyStreakFreeze (R22.5 — up to 3 days)", () => {
  it("freezes exactly the requested span, clamped to [1,3]", () => {
    const base = { count: 5, lastConfirmedDay: "2025-01-05", freezeUntil: null };
    expect(applyStreakFreeze(base, "2025-01-06", 3).freezeUntil).toBe("2025-01-08");
    expect(applyStreakFreeze(base, "2025-01-06", 1).freezeUntil).toBe("2025-01-06");
    // Over-max clamps to 3 days (last frozen day = start + 2).
    expect(applyStreakFreeze(base, "2025-01-06", 10).freezeUntil).toBe("2025-01-08");
    // Under-min clamps to 1 day.
    expect(applyStreakFreeze(base, "2025-01-06", 0).freezeUntil).toBe("2025-01-06");
  });

  it("never exceeds MAX_STREAK_FREEZE_DAYS and preserves the count", () => {
    const base = { count: 5, lastConfirmedDay: "2025-01-05", freezeUntil: null };
    const frozen = applyStreakFreeze(base, "2025-01-06", 3);
    expect(frozen.count).toBe(5);
    expect(MAX_STREAK_FREEZE_DAYS).toBe(3);
    // 3 days: 06, 07, 08 are all within the freeze; 09 is not.
    expect(isFrozen(frozen, "2025-01-06")).toBe(true);
    expect(isFrozen(frozen, "2025-01-08")).toBe(true);
    expect(isFrozen(frozen, "2025-01-09")).toBe(false);
  });
});

describe("resolveUnconfirmedDay (R22.3/R22.5 — a frozen day never breaks)", () => {
  it("preserves the streak on a frozen unconfirmed day (no increment, no break)", () => {
    const base = { count: 5, lastConfirmedDay: "2025-01-05", freezeUntil: null };
    const frozen = applyStreakFreeze(base, "2025-01-06", 3);
    const out = resolveUnconfirmedDay(frozen, "2025-01-07");
    expect(out.frozen).toBe(true);
    expect(out.reset).toBe(false);
    expect(out.state.count).toBe(5); // unchanged
  });

  it("resets the streak on an unconfirmed day outside any freeze (R22.3)", () => {
    const base = { count: 5, lastConfirmedDay: "2025-01-05", freezeUntil: null };
    const out = resolveUnconfirmedDay(base, "2025-01-06");
    expect(out.reset).toBe(true);
    expect(out.state.count).toBe(0);
  });

  it("clears an elapsed freeze and resets once the freeze window passes", () => {
    const base = { count: 5, lastConfirmedDay: "2025-01-05", freezeUntil: null };
    const frozen = applyStreakFreeze(base, "2025-01-06", 3); // until 2025-01-08
    const out = resolveUnconfirmedDay(frozen, "2025-01-09");
    expect(out.frozen).toBe(false);
    expect(out.reset).toBe(true);
    expect(out.state.count).toBe(0);
    expect(out.state.freezeUntil).toBeNull();
  });
});
