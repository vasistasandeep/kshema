/**
 * Idle-lock timer for the Observer web portal (R28.4).
 *
 * After 30 minutes with no user interaction, the portal locks and requires
 * biometric/passcode re-authentication before further use. The timer resets on
 * any user activity. This module is a pure, framework-agnostic state machine so
 * the 30-minute rule is unit-testable without a DOM; a thin React hook wires it
 * to real `document` events and a wall clock.
 */
import { IDLE_LOCK_MS } from "./config";

export interface IdleLockState {
  /** Timestamp (ms) of the most recent user activity. */
  lastActivityAt: number;
  /** Whether the interface is currently locked. */
  locked: boolean;
}

export function createIdleState(now: number): IdleLockState {
  return { lastActivityAt: now, locked: false };
}

/** Record user activity. A locked interface stays locked until re-auth. */
export function recordActivity(
  state: IdleLockState,
  now: number,
): IdleLockState {
  if (state.locked) return state;
  return { ...state, lastActivityAt: now };
}

/** True once the idle window has elapsed since the last activity. */
export function isIdleExpired(
  state: IdleLockState,
  now: number,
  idleMs: number = IDLE_LOCK_MS,
): boolean {
  return now - state.lastActivityAt >= idleMs;
}

/** Advance the clock; lock the interface if the idle window has elapsed. */
export function tick(
  state: IdleLockState,
  now: number,
  idleMs: number = IDLE_LOCK_MS,
): IdleLockState {
  if (state.locked) return state;
  if (isIdleExpired(state, now, idleMs)) {
    return { ...state, locked: true };
  }
  return state;
}

/** Clear the lock after a successful re-authentication. */
export function unlock(state: IdleLockState, now: number): IdleLockState {
  return { lastActivityAt: now, locked: false };
}
