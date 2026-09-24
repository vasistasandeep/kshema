/**
 * Routine-confirmation state machine (R5.6, R6.4, R6.5).
 *
 * A pending morning `grace-check` starts unconfirmed. A *confirming signal* — a
 * screen unlock, a positive step delta, a charger unplug, or any Ghost_Signal —
 * that arrives **strictly before** the Grace_Deadline marks the check confirmed
 * and, per R6.5, is sufficient to prevent any Safety_Incident from opening for
 * that check.
 *
 * Everything here is pure: `applyConfirmingSignal` is a deterministic state
 * transition over `(state, signal, deadline)` with no clock reads, no I/O and no
 * mutation of its inputs, so the `rhythm-eval` processor and the
 * `telemetry.received` / `ghost.received` event handlers can call it in tests
 * without Redis or a DB.
 *
 * Design references: sequence "if unlock/step/ghost satisfies pending check →
 * confirm (R5.6, R6.4)" and Property 9 ("Confirming signal prevents escalation").
 */

/** The four kinds of signal that can confirm a morning routine (R5.6, R6.4). */
export type ConfirmingSignalType =
  | "screen_unlock"
  | "step_delta"
  | "charger_unplug"
  | "ghost_signal";

/**
 * A single observed signal considered for confirmation.
 *
 * `stepDelta` is only meaningful for `step_delta` signals: only a **positive**
 * delta confirms (a zero/negative delta is not evidence of activity). All other
 * signal types confirm by their mere occurrence.
 */
export interface ConfirmingSignal {
  type: ConfirmingSignalType;
  /** Epoch-millis (or any monotonic ms clock) the signal was observed at. */
  at: number;
  /** Step delta for `step_delta` signals; ignored otherwise. */
  stepDelta?: number;
}

/** The confirmation state of a pending morning grace-check. */
export interface GraceCheckState {
  /** The Anchor this check belongs to. */
  anchorId: string;
  /** Local calendar day the check belongs to (e.g. `2025-01-31`). */
  serviceDay: string;
  /** Grace_Deadline as an epoch-millis instant; signals must beat this. */
  deadline: number;
  /** Whether a confirming signal has been accepted before the deadline. */
  confirmed: boolean;
  /** The signal that confirmed the check, if any. */
  confirmedBy?: ConfirmingSignal;
}

/** Inputs needed to create a fresh (unconfirmed) grace-check state. */
export interface CreateGraceCheckStateInput {
  anchorId: string;
  serviceDay: string;
  /** Grace_Deadline as an epoch-millis instant. */
  deadline: number;
}

/** Create a fresh, unconfirmed grace-check state. */
export function createGraceCheckState(
  input: CreateGraceCheckStateInput,
): GraceCheckState {
  return {
    anchorId: input.anchorId,
    serviceDay: input.serviceDay,
    deadline: input.deadline,
    confirmed: false,
  };
}

/**
 * Decide whether a signal, on its own merits, is a *confirming* signal.
 *
 * Timing is deliberately not considered here — this only asks "is this the kind
 * of signal that confirms activity?". A `step_delta` confirms only when the
 * delta is strictly positive; every other type confirms by occurrence.
 */
export function isConfirmingSignal(signal: ConfirmingSignal): boolean {
  switch (signal.type) {
    case "screen_unlock":
    case "charger_unplug":
    case "ghost_signal":
      return true;
    case "step_delta":
      return (signal.stepDelta ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * Whether a signal arrived in time to confirm the check.
 *
 * The comparison is strict (`<`): a signal must arrive **before** the deadline.
 * A signal at exactly the deadline, or after it, does not retroactively confirm
 * (Property 9's "a signal AFTER the deadline does not retroactively prevent").
 */
export function isBeforeDeadline(
  signal: ConfirmingSignal,
  deadline: number,
): boolean {
  return signal.at < deadline;
}

/**
 * Apply a signal to a pending grace-check (pure state transition).
 *
 * The check transitions to `confirmed` iff the signal is a confirming signal
 * (R5.6/R6.4) AND it arrived strictly before the deadline. Once confirmed the
 * state is terminal: later signals never un-confirm it and the first confirming
 * signal is retained as `confirmedBy`. A non-confirming or late signal returns
 * the state unchanged (identity), so folding a stream of signals is safe and
 * order-independent for the confirmed outcome.
 */
export function applyConfirmingSignal(
  state: GraceCheckState,
  signal: ConfirmingSignal,
): GraceCheckState {
  if (state.confirmed) {
    // Terminal: a confirmed check stays confirmed, keep the original signal.
    return state;
  }
  if (!isConfirmingSignal(signal) || !isBeforeDeadline(signal, state.deadline)) {
    return state;
  }
  return { ...state, confirmed: true, confirmedBy: signal };
}

/**
 * Fold a batch of signals into a grace-check state.
 *
 * Convenience over {@link applyConfirmingSignal} for the common case of
 * replaying several buffered signals (e.g. an offline queue flush). The result
 * is confirmed iff *any* signal in the batch is a confirming signal before the
 * deadline.
 */
export function applyConfirmingSignals(
  state: GraceCheckState,
  signals: readonly ConfirmingSignal[],
): GraceCheckState {
  return signals.reduce(applyConfirmingSignal, state);
}

/**
 * The escalation gate (R6.5): a confirmed check must prevent any incident.
 *
 * Returns `true` when it is safe to open/continue an incident for this check —
 * i.e. the check is **not** confirmed. When the check is confirmed this returns
 * `false`, and the caller MUST NOT open a Safety_Incident.
 */
export function shouldEscalate(state: GraceCheckState): boolean {
  return !state.confirmed;
}
