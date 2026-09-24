/**
 * Persona-mode evaluators (Requirement 3).
 *
 * Each Persona_Mode is a pure predicate: given the mode's inputs it decides
 * whether that mode's *trigger condition* is met — i.e. whether the Sentinel
 * would raise (as opposed to withhold) a Safety_Incident for that mode. No I/O,
 * no clock reads, no mutation; the `rhythm-eval` processor injects the values.
 *
 * The five modes (R3.1):
 *  - Elderly_Care     — adaptive wake-rhythm miss (uses the rhythm engine's
 *                       Grace_Deadline). This is the DEFAULT mode (R3.2, R3.4).
 *  - Solo_Living      — inactivity window exceeded (R3.5).
 *  - Active_Session   — immobility during an active session (R3.6).
 *  - Journey_Watch    — transit deadline exceeded (R3.7).
 *  - Post_Op_Recovery — daytime inactivity exceeded a recovery threshold (R3.8).
 *
 * Modes may run CONCURRENTLY for one Anchor (R3.9); {@link evaluatePersonaModes}
 * runs every enabled mode and aggregates with an any-triggered-escalates rule.
 */

import {
  computeGraceDeadline,
  type GraceDeadlineInput,
} from "../rhythm/engine.js";

/**
 * Canonical persona-mode identifiers. These mirror the `SentinelMode` Prisma
 * enum (`ELDERLY_CARE | SOLO_LIVING | ACTIVE_SESSION | JOURNEY_WATCH |
 * POST_OP_RECOVERY`) but are kept as a local string-literal union so this pure
 * module carries no DB dependency.
 */
export type PersonaMode =
  | "ELDERLY_CARE"
  | "SOLO_LIVING"
  | "ACTIVE_SESSION"
  | "JOURNEY_WATCH"
  | "POST_OP_RECOVERY";

/** Every persona mode, in the design's declared order (R3.1). */
export const PERSONA_MODES: readonly PersonaMode[] = [
  "ELDERLY_CARE",
  "SOLO_LIVING",
  "ACTIVE_SESSION",
  "JOURNEY_WATCH",
  "POST_OP_RECOVERY",
] as const;

/** The default persona applied when none is selected (R3.2). */
export const DEFAULT_PERSONA_MODE: PersonaMode = "ELDERLY_CARE";

/**
 * Resolve the set of active modes for an Anchor.
 *
 * When the policy selects no modes, Elderly_Care is applied as the default
 * (R3.2). Duplicates are collapsed and order follows {@link PERSONA_MODES}.
 */
export function resolveActiveModes(
  selected: readonly PersonaMode[] | undefined | null,
): PersonaMode[] {
  if (!selected || selected.length === 0) {
    return [DEFAULT_PERSONA_MODE];
  }
  const set = new Set(selected);
  return PERSONA_MODES.filter((m) => set.has(m));
}

/** The outcome of evaluating one mode. */
export interface ModeEvaluation {
  mode: PersonaMode;
  /** `true` when the mode's condition is met and it wants to escalate. */
  triggered: boolean;
  /** Human-readable reason for logging/audit. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Elderly_Care — adaptive wake-rhythm miss (R3.4)
// ---------------------------------------------------------------------------

/**
 * Inputs for Elderly_Care. The wake baseline + offset inputs feed the rhythm
 * engine's {@link computeGraceDeadline}; `nowMinuteOfDay` is the current clock
 * minute-of-day being evaluated, and `routineConfirmed` short-circuits to "not
 * triggered" when a confirming signal already landed (R5.6/R6.5).
 */
export interface ElderlyCareInput extends GraceDeadlineInput {
  /** Current clock minute-of-day (0..1439) at evaluation time. */
  nowMinuteOfDay: number;
  /** Whether the morning routine has already been confirmed. */
  routineConfirmed: boolean;
}

/**
 * Elderly_Care evaluator (R3.4): triggers when the morning routine is
 * unconfirmed AND the current time is at/after the adaptive Grace_Deadline.
 *
 * The deadline comparison uses the un-wrapped `rawMinuteOfDay` when it does not
 * wrap past midnight; a deadline that wraps past midnight is treated against the
 * wrapped `minuteOfDay`. A confirmed routine never triggers (R5.6/R6.5).
 */
export function evaluateElderlyCare(input: ElderlyCareInput): ModeEvaluation {
  if (input.routineConfirmed) {
    return {
      mode: "ELDERLY_CARE",
      triggered: false,
      reason: "morning routine confirmed before Grace_Deadline",
    };
  }
  const deadline = computeGraceDeadline(input);
  const deadlineMinute = deadline.wrapsPastMidnight
    ? deadline.minuteOfDay
    : deadline.rawMinuteOfDay;
  const triggered = input.nowMinuteOfDay >= deadlineMinute;
  return {
    mode: "ELDERLY_CARE",
    triggered,
    reason: triggered
      ? `Grace_Deadline missed (now ${input.nowMinuteOfDay} >= deadline ${deadlineMinute})`
      : `within Grace_Deadline (now ${input.nowMinuteOfDay} < deadline ${deadlineMinute})`,
  };
}

// ---------------------------------------------------------------------------
// Solo_Living — prolonged absence of passive activity (R3.5)
// ---------------------------------------------------------------------------

/** Inputs for Solo_Living inactivity evaluation. */
export interface SoloLivingInput {
  /** Minutes since the last passive activity signal. */
  minutesSinceLastActivity: number;
  /** Inactivity window in minutes; exceeding it triggers. */
  inactivityWindowMin: number;
}

/**
 * Solo_Living evaluator (R3.5): triggers when the time since the last passive
 * activity signal **exceeds** the configured inactivity window. The comparison
 * is strict (`>`): sitting exactly at the window boundary does not yet trigger.
 */
export function evaluateSoloLiving(input: SoloLivingInput): ModeEvaluation {
  const triggered =
    input.minutesSinceLastActivity > input.inactivityWindowMin;
  return {
    mode: "SOLO_LIVING",
    triggered,
    reason: triggered
      ? `inactivity ${input.minutesSinceLastActivity}m exceeds window ${input.inactivityWindowMin}m`
      : `inactivity ${input.minutesSinceLastActivity}m within window ${input.inactivityWindowMin}m`,
  };
}

// ---------------------------------------------------------------------------
// Active_Session — immobility during an active session (R3.6)
// ---------------------------------------------------------------------------

/** Inputs for Active_Session immobility evaluation. */
export interface ActiveSessionInput {
  /** Whether a session is currently active. Immobility only counts in-session. */
  sessionActive: boolean;
  /** Continuous minutes of detected immobility. */
  immobileMinutes: number;
  /** Immobility threshold in minutes; exceeding it triggers. */
  immobilityThresholdMin: number;
}

/**
 * Active_Session evaluator (R3.6): triggers when a session is active AND
 * continuous immobility **exceeds** the threshold. Outside an active session the
 * mode never triggers regardless of immobility. Comparison is strict (`>`).
 */
export function evaluateActiveSession(
  input: ActiveSessionInput,
): ModeEvaluation {
  if (!input.sessionActive) {
    return {
      mode: "ACTIVE_SESSION",
      triggered: false,
      reason: "no active session",
    };
  }
  const triggered = input.immobileMinutes > input.immobilityThresholdMin;
  return {
    mode: "ACTIVE_SESSION",
    triggered,
    reason: triggered
      ? `immobile ${input.immobileMinutes}m exceeds threshold ${input.immobilityThresholdMin}m during active session`
      : `immobile ${input.immobileMinutes}m within threshold ${input.immobilityThresholdMin}m`,
  };
}

// ---------------------------------------------------------------------------
// Journey_Watch — arrival vs a transit deadline (R3.7)
// ---------------------------------------------------------------------------

/** Inputs for Journey_Watch transit-deadline evaluation. */
export interface JourneyWatchInput {
  /** Current time as epoch-millis. */
  now: number;
  /** User-specified transit deadline as epoch-millis. */
  transitDeadline: number;
  /** Whether arrival has been confirmed. A confirmed arrival never triggers. */
  arrived: boolean;
}

/**
 * Journey_Watch evaluator (R3.7): triggers when arrival is not yet confirmed
 * AND the current time is at/after the transit deadline. A confirmed arrival
 * never triggers regardless of the clock.
 */
export function evaluateJourneyWatch(
  input: JourneyWatchInput,
): ModeEvaluation {
  if (input.arrived) {
    return {
      mode: "JOURNEY_WATCH",
      triggered: false,
      reason: "arrival confirmed before transit deadline",
    };
  }
  const triggered = input.now >= input.transitDeadline;
  return {
    mode: "JOURNEY_WATCH",
    triggered,
    reason: triggered
      ? "transit deadline exceeded without arrival"
      : "within transit deadline",
  };
}

// ---------------------------------------------------------------------------
// Post_Op_Recovery — daytime inactivity vs a recovery threshold (R3.8)
// ---------------------------------------------------------------------------

/** Inputs for Post_Op_Recovery daytime-inactivity evaluation. */
export interface PostOpRecoveryInput {
  /** Whether the current time falls within configured daytime hours. */
  isDaytime: boolean;
  /** Minutes of daytime inactivity observed. */
  daytimeInactiveMinutes: number;
  /** Recovery inactivity threshold in minutes; exceeding it triggers. */
  recoveryThresholdMin: number;
}

/**
 * Post_Op_Recovery evaluator (R3.8): triggers when the current time is daytime
 * AND daytime inactivity **exceeds** the recovery threshold. Outside daytime it
 * never triggers. Comparison is strict (`>`).
 */
export function evaluatePostOpRecovery(
  input: PostOpRecoveryInput,
): ModeEvaluation {
  if (!input.isDaytime) {
    return {
      mode: "POST_OP_RECOVERY",
      triggered: false,
      reason: "outside daytime recovery window",
    };
  }
  const triggered =
    input.daytimeInactiveMinutes > input.recoveryThresholdMin;
  return {
    mode: "POST_OP_RECOVERY",
    triggered,
    reason: triggered
      ? `daytime inactivity ${input.daytimeInactiveMinutes}m exceeds threshold ${input.recoveryThresholdMin}m`
      : `daytime inactivity ${input.daytimeInactiveMinutes}m within threshold ${input.recoveryThresholdMin}m`,
  };
}

// ---------------------------------------------------------------------------
// Concurrent-mode aggregation (R3.9)
// ---------------------------------------------------------------------------

/**
 * Per-mode inputs bundle. Each field is optional; only modes that are both
 * enabled AND supplied with inputs are evaluated. A mode enabled without inputs
 * is reported as skipped (not triggered) so a misconfiguration never silently
 * escalates.
 */
export interface PersonaEvaluationInputs {
  ELDERLY_CARE?: ElderlyCareInput;
  SOLO_LIVING?: SoloLivingInput;
  ACTIVE_SESSION?: ActiveSessionInput;
  JOURNEY_WATCH?: JourneyWatchInput;
  POST_OP_RECOVERY?: PostOpRecoveryInput;
}

/** The aggregated result of running all enabled modes. */
export interface AggregatePersonaEvaluation {
  /** The modes that were actually evaluated (enabled + had inputs). */
  evaluations: ModeEvaluation[];
  /** `true` iff ANY evaluated mode triggered (R3.9 concurrent aggregation). */
  escalate: boolean;
  /** The modes that triggered, for audit/logging. */
  triggeredModes: PersonaMode[];
}

/**
 * Evaluate every enabled Persona_Mode and aggregate (R3.9).
 *
 * Aggregation rule: **any triggered mode escalates**. Modes run concurrently and
 * independently; one mode triggering is sufficient to escalate even if others
 * withhold. Enabled modes lacking inputs are skipped (treated as not triggered).
 * When no modes are enabled the default Elderly_Care is used (R3.2) — but it can
 * only be evaluated if Elderly_Care inputs are supplied.
 */
export function evaluatePersonaModes(
  enabledModes: readonly PersonaMode[] | undefined | null,
  inputs: PersonaEvaluationInputs,
): AggregatePersonaEvaluation {
  const active = resolveActiveModes(enabledModes);
  const evaluations: ModeEvaluation[] = [];

  for (const mode of active) {
    switch (mode) {
      case "ELDERLY_CARE":
        if (inputs.ELDERLY_CARE) {
          evaluations.push(evaluateElderlyCare(inputs.ELDERLY_CARE));
        }
        break;
      case "SOLO_LIVING":
        if (inputs.SOLO_LIVING) {
          evaluations.push(evaluateSoloLiving(inputs.SOLO_LIVING));
        }
        break;
      case "ACTIVE_SESSION":
        if (inputs.ACTIVE_SESSION) {
          evaluations.push(evaluateActiveSession(inputs.ACTIVE_SESSION));
        }
        break;
      case "JOURNEY_WATCH":
        if (inputs.JOURNEY_WATCH) {
          evaluations.push(evaluateJourneyWatch(inputs.JOURNEY_WATCH));
        }
        break;
      case "POST_OP_RECOVERY":
        if (inputs.POST_OP_RECOVERY) {
          evaluations.push(evaluatePostOpRecovery(inputs.POST_OP_RECOVERY));
        }
        break;
    }
  }

  const triggeredModes = evaluations
    .filter((e) => e.triggered)
    .map((e) => e.mode);

  return {
    evaluations,
    escalate: triggeredModes.length > 0,
    triggeredModes,
  };
}
