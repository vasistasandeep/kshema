"use client";

/**
 * React hook wiring the pure idle-lock state machine (`./idle-lock`) to real
 * DOM activity events and a wall clock (R28.4). After 30 idle minutes the
 * portal locks; any pointer/key/scroll activity resets the timer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createIdleState,
  recordActivity,
  tick as advance,
  unlock as unlockState,
  type IdleLockState,
} from "./idle-lock";

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "scroll",
  "touchstart",
] as const;

const POLL_MS = 15_000;

export function useIdleLock(): { locked: boolean; unlock: () => void } {
  const stateRef = useRef<IdleLockState>(createIdleState(Date.now()));
  const [locked, setLocked] = useState(false);

  const sync = useCallback(() => {
    setLocked(stateRef.current.locked);
  }, []);

  useEffect(() => {
    const onActivity = () => {
      stateRef.current = recordActivity(stateRef.current, Date.now());
    };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    const timer = window.setInterval(() => {
      stateRef.current = advance(stateRef.current, Date.now());
      sync();
    }, POLL_MS);

    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
      window.clearInterval(timer);
    };
  }, [sync]);

  const unlock = useCallback(() => {
    stateRef.current = unlockState(stateRef.current, Date.now());
    setLocked(false);
  }, []);

  return { locked, unlock };
}
