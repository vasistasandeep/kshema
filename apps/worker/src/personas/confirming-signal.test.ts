import { describe, expect, it } from "vitest";

import {
  applyConfirmingSignal,
  applyConfirmingSignals,
  createGraceCheckState,
  isBeforeDeadline,
  isConfirmingSignal,
  shouldEscalate,
  type ConfirmingSignal,
  type ConfirmingSignalType,
} from "./confirming-signal.js";

const DEADLINE = 1_000;

function freshState() {
  return createGraceCheckState({
    anchorId: "anchor1",
    serviceDay: "2025-01-31",
    deadline: DEADLINE,
  });
}

describe("isConfirmingSignal (R5.6, R6.4)", () => {
  it("confirms on screen unlock, charger unplug, and ghost signal by occurrence", () => {
    for (const type of [
      "screen_unlock",
      "charger_unplug",
      "ghost_signal",
    ] as ConfirmingSignalType[]) {
      expect(isConfirmingSignal({ type, at: 0 })).toBe(true);
    }
  });

  it("confirms on a positive step delta only", () => {
    expect(isConfirmingSignal({ type: "step_delta", at: 0, stepDelta: 5 })).toBe(
      true,
    );
    expect(isConfirmingSignal({ type: "step_delta", at: 0, stepDelta: 0 })).toBe(
      false,
    );
    expect(
      isConfirmingSignal({ type: "step_delta", at: 0, stepDelta: -3 }),
    ).toBe(false);
    // missing delta => not confirming
    expect(isConfirmingSignal({ type: "step_delta", at: 0 })).toBe(false);
  });
});

describe("isBeforeDeadline", () => {
  it("is strict: a signal at exactly the deadline is not before it", () => {
    expect(isBeforeDeadline({ type: "ghost_signal", at: DEADLINE }, DEADLINE)).toBe(
      false,
    );
    expect(
      isBeforeDeadline({ type: "ghost_signal", at: DEADLINE - 1 }, DEADLINE),
    ).toBe(true);
    expect(
      isBeforeDeadline({ type: "ghost_signal", at: DEADLINE + 1 }, DEADLINE),
    ).toBe(false);
  });
});

describe("applyConfirmingSignal — each signal type confirms & prevents escalation (R5.6, R6.4, R6.5)", () => {
  const cases: { type: ConfirmingSignalType; signal: ConfirmingSignal }[] = [
    { type: "screen_unlock", signal: { type: "screen_unlock", at: 500 } },
    {
      type: "step_delta",
      signal: { type: "step_delta", at: 500, stepDelta: 12 },
    },
    { type: "charger_unplug", signal: { type: "charger_unplug", at: 500 } },
    { type: "ghost_signal", signal: { type: "ghost_signal", at: 500 } },
  ];

  for (const { type, signal } of cases) {
    it(`${type} before the deadline confirms and prevents escalation`, () => {
      const next = applyConfirmingSignal(freshState(), signal);
      expect(next.confirmed).toBe(true);
      expect(next.confirmedBy).toEqual(signal);
      expect(shouldEscalate(next)).toBe(false);
    });
  }
});

describe("applyConfirmingSignal — timing (Property 9 boundary)", () => {
  it("a confirming signal AFTER the deadline does not retroactively prevent escalation", () => {
    const late: ConfirmingSignal = { type: "screen_unlock", at: DEADLINE + 1 };
    const next = applyConfirmingSignal(freshState(), late);
    expect(next.confirmed).toBe(false);
    expect(shouldEscalate(next)).toBe(true);
  });

  it("a signal exactly AT the deadline does not confirm (strict before)", () => {
    const atDeadline: ConfirmingSignal = { type: "ghost_signal", at: DEADLINE };
    const next = applyConfirmingSignal(freshState(), atDeadline);
    expect(next.confirmed).toBe(false);
  });

  it("a non-confirming signal (zero step delta) leaves state unchanged", () => {
    const state = freshState();
    const next = applyConfirmingSignal(state, {
      type: "step_delta",
      at: 100,
      stepDelta: 0,
    });
    expect(next).toBe(state);
    expect(shouldEscalate(next)).toBe(true);
  });
});

describe("applyConfirmingSignal — confirmation is terminal", () => {
  it("keeps the first confirming signal and never un-confirms", () => {
    const first: ConfirmingSignal = { type: "screen_unlock", at: 300 };
    const confirmed = applyConfirmingSignal(freshState(), first);
    // A later (even confirming) signal does not overwrite confirmedBy.
    const again = applyConfirmingSignal(confirmed, {
      type: "ghost_signal",
      at: 400,
    });
    expect(again.confirmed).toBe(true);
    expect(again.confirmedBy).toEqual(first);
  });
});

describe("applyConfirmingSignals — batch fold", () => {
  it("confirms iff any signal confirms before the deadline", () => {
    const signals: ConfirmingSignal[] = [
      { type: "step_delta", at: 200, stepDelta: 0 }, // not confirming
      { type: "screen_unlock", at: DEADLINE + 5 }, // late
      { type: "ghost_signal", at: 900 }, // confirming, before deadline
    ];
    const next = applyConfirmingSignals(freshState(), signals);
    expect(next.confirmed).toBe(true);
    expect(shouldEscalate(next)).toBe(false);
  });

  it("stays unconfirmed when no signal qualifies", () => {
    const signals: ConfirmingSignal[] = [
      { type: "step_delta", at: 200, stepDelta: -1 },
      { type: "charger_unplug", at: DEADLINE + 1 },
    ];
    const next = applyConfirmingSignals(freshState(), signals);
    expect(next.confirmed).toBe(false);
    expect(shouldEscalate(next)).toBe(true);
  });
});
