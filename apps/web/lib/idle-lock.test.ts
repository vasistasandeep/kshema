/**
 * Idle-lock state machine tests (R28.4): locks after 30 idle minutes, resets on
 * activity, and stays locked until an explicit unlock.
 */
import { describe, expect, it } from "vitest";
import {
  createIdleState,
  isIdleExpired,
  recordActivity,
  tick,
  unlock,
} from "./idle-lock";

const MIN = 60_000;
const IDLE = 30 * MIN;

describe("idle lock (R28.4)", () => {
  it("does not lock before 30 idle minutes", () => {
    const s = createIdleState(0);
    expect(isIdleExpired(s, 29 * MIN, IDLE)).toBe(false);
    expect(tick(s, 29 * MIN, IDLE).locked).toBe(false);
  });

  it("locks at exactly 30 idle minutes", () => {
    const s = createIdleState(0);
    expect(isIdleExpired(s, IDLE, IDLE)).toBe(true);
    expect(tick(s, IDLE, IDLE).locked).toBe(true);
  });

  it("activity resets the idle window", () => {
    let s = createIdleState(0);
    s = recordActivity(s, 20 * MIN);
    // 25 min after last activity (not 45 since epoch) — still under threshold.
    expect(tick(s, 45 * MIN, IDLE).locked).toBe(false);
    // 30 min after the last activity — now it locks.
    expect(tick(s, 50 * MIN, IDLE).locked).toBe(true);
  });

  it("stays locked and ignores activity until explicitly unlocked", () => {
    let s = tick(createIdleState(0), IDLE, IDLE);
    expect(s.locked).toBe(true);
    s = recordActivity(s, IDLE + MIN);
    expect(s.locked).toBe(true);
    s = unlock(s, IDLE + 2 * MIN);
    expect(s.locked).toBe(false);
  });
});
