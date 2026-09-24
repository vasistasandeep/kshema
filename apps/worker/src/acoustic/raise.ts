/**
 * Acoustic-distress incident raise (R10.3, R10.4; task 13.7).
 *
 * The Acoustic_Distress_Classifier runs entirely on-device (R10.2, task 22.3)
 * and never persists or transmits audio (R19.4). What lands in the worker is a
 * *classification signal* — a distilled `{confidence, sustainedSec,
 * motionlessSec}` tuple. This module decides, from that signal alone, whether
 * to raise a Safety_Incident, and if so raises it **directly at STAGE_2**
 * (`STAGE_2_GENTLE_DEVICE_CHIME`) rather than at STAGE_1.
 *
 * Why STAGE_2 (and how it differs from {@link openIncident}):
 *   - Grace_Deadline misses (R12.1) open a *conversational* incident at STAGE_1
 *     — the check-in WhatsApp gives a well Anchor a gentle way to dismiss.
 *   - An acoustic distress hit (heavy impact / glass / vocal distress + the
 *     Anchor motionless ≥ 30s) is a materially stronger signal, so R10.3
 *     requires entering the ladder one rung higher, at STAGE_2, emitting the
 *     device chime immediately.
 *
 * `fsm.ts`'s {@link openIncident} always opens at STAGE_1 and is intentionally
 * left untouched (other concurrent tasks depend on it). Instead this module
 * takes its *own* injectable "create the incident at a given stage" seam
 * ({@link AcousticRaiseDeps.createIncidentAtStage}) so it can model the
 * STAGE_2 entry without special-casing the STAGE_1 FSM. It still reuses the
 * FSM's pure vocabulary — {@link AuditEntry}, {@link ScheduledAdvance},
 * {@link StageSideEffect}, {@link nextStage}, {@link sideEffectForStage},
 * {@link stageNumber} — so the raised incident is indistinguishable from a
 * STAGE_1-opened one once it is on the ladder: it fires the STAGE_2 chime and
 * schedules the STAGE_3 advance with the same deterministic
 * `incident:<id>:stage3` id.
 *
 * Everything lives behind injectable seams ({@link AcousticRaiseDeps}) so tests
 * stay hermetic (no Redis/DB) and the gating predicate is pure.
 */

import type { IncidentStage } from "@kshema/database";

import { escalationJobId } from "../jobs/job-id.js";
import {
  nextStage,
  sideEffectForStage,
  stageNumber,
  type AuditEntry,
  type ScheduledAdvance,
  type StageSideEffect,
} from "../escalation/fsm.js";

/** Confidence must be *strictly greater* than this to qualify (R10.3/R10.4). */
export const ACOUSTIC_CONFIDENCE_THRESHOLD = 0.82;
/** Sustained duration must be *strictly greater* than this (seconds, R10.3). */
export const ACOUSTIC_SUSTAINED_THRESHOLD_SEC = 1.5;
/** Motionlessness must be *at least* this (seconds, inclusive, R10.3). */
export const ACOUSTIC_MOTIONLESS_THRESHOLD_SEC = 30;

/** The stage an acoustic-distress hit raises the incident directly into (R10.3). */
export const ACOUSTIC_RAISE_STAGE =
  "STAGE_2_GENTLE_DEVICE_CHIME" as const satisfies IncidentStage;

/** The audit cause recorded on the STAGE_2 entry for an acoustic raise. */
export const ACOUSTIC_CAUSE = "ACOUSTIC_DISTRESS" as const;

/** A distilled on-device acoustic classification signal (R10.3). */
export interface AcousticSignal {
  /** Classifier confidence in the distress category, in [0, 1]. */
  confidence: number;
  /** How long (seconds) the classification was sustained. */
  sustainedSec: number;
  /** How long (seconds) the Anchor device has reported motionlessness. */
  motionlessSec: number;
}

/**
 * Pure gating predicate (R10.3, R10.4).
 *
 * Returns `true` **iff** ALL of:
 *   - `confidence > 0.82` (strict — 0.82 and below are excluded, R10.4),
 *   - `sustainedSec > 1.5` (strict), and
 *   - `motionlessSec >= 30` (inclusive).
 *
 * Non-finite inputs (NaN / ±Infinity) never qualify: all comparisons against a
 * NaN are `false`, and Infinity only fails the strict upper-bound-free checks
 * when it is on the wrong side, so this is safe by construction. The function
 * has no side effects and is the single source of truth for the threshold.
 */
export function shouldRaiseAcousticIncident(signal: AcousticSignal): boolean {
  return (
    signal.confidence > ACOUSTIC_CONFIDENCE_THRESHOLD &&
    signal.sustainedSec > ACOUSTIC_SUSTAINED_THRESHOLD_SEC &&
    signal.motionlessSec >= ACOUSTIC_MOTIONLESS_THRESHOLD_SEC
  );
}

/**
 * Injectable side-effect seams for the acoustic raise. Deliberately narrow and
 * distinct from {@link EscalationDeps}: acoustic needs to create *at STAGE_2*,
 * so it takes a stage-parameterized create seam rather than the STAGE_1-only
 * `createIncident`.
 */
export interface AcousticRaiseDeps {
  /**
   * Persist a brand-new incident *at the given stage* with the given audit
   * trail and return its stable id. Production wiring performs the Prisma
   * `create` with `stage: input.stage`; tests pass a spy that returns a
   * synthetic id. (Contrast with `fsm.ts`'s `createIncident`, which always
   * creates at STAGE_1.)
   */
  createIncidentAtStage: (input: {
    circleId: string;
    anchorId: string;
    stage: IncidentStage;
    cause: string;
    auditTrail: AuditEntry[];
    simulated?: boolean;
  }) => Promise<{ id: string }>;
  /**
   * Perform a stage's real-world side-effect (here: the STAGE_2 device chime).
   * Enqueues onto the `dispatch` queue in production; a spy in tests.
   */
  performSideEffect: (effect: StageSideEffect) => Promise<void>;
  /**
   * Enqueue the next delayed `advance` job (here: the STAGE_3 advance).
   * Production wiring closes over `escalationQueue.add`; idempotent by `jobId`.
   */
  scheduleAdvance: (advance: ScheduledAdvance) => Promise<void>;
}

/** Inputs to raise an incident from an acoustic classification signal (R10.3). */
export interface RaiseAcousticInput {
  circleId: string;
  anchorId: string;
  /** The distilled on-device classification signal. */
  signal: AcousticSignal;
  /** Wall-clock now (epoch-millis); injected for deterministic tests. */
  now: number;
  /** Timed-advance interval; +20m in prod, compressed in Simulation_Mode. */
  stageIntervalMs: number;
  /** Flag the incident as simulated (Simulation_Mode, R25.4). */
  simulated?: boolean;
}

/** Outcome of {@link raiseAcousticIncident}. */
export type RaiseAcousticOutcome =
  | {
      /** The signal was at/below threshold: nothing raised (R10.4). */
      raised: false;
      reason: "below-threshold";
    }
  | {
      raised: true;
      incidentId: string;
      /** Always STAGE_2 for an acoustic raise. */
      stage: IncidentStage;
      /** The STAGE_2 audit entry recording the acoustic cause. */
      auditTrail: AuditEntry[];
      /** The STAGE_2 device-chime side-effect performed on raise. */
      effect: StageSideEffect;
      /** The STAGE_3 advance scheduled (never null — STAGE_2 is not terminal). */
      scheduled: ScheduledAdvance;
    };

/**
 * Raise a Safety_Incident directly at STAGE_2 from an acoustic classification
 * signal (R10.3), or do nothing when the signal is at/below threshold (R10.4).
 *
 * When {@link shouldRaiseAcousticIncident} holds, the order of operations
 * mirrors the FSM's open/advance shape but *entered at STAGE_2*:
 *   1. create the incident at STAGE_2 with a STAGE_2 audit entry whose cause is
 *      {@link ACOUSTIC_CAUSE} (recorded in the audit trail, R12.6),
 *   2. fire the STAGE_2 device-chime side-effect (R12.2), and
 *   3. schedule the STAGE_3 advance as a delayed job with the deterministic
 *      `incident:<id>:stage3` id (identical to a STAGE_1-opened incident once
 *      it reaches STAGE_2, so the rest of the ladder is unchanged).
 *
 * Otherwise it is a strict no-op: no incident, no chime, no scheduling (R10.4).
 */
export async function raiseAcousticIncident(
  deps: AcousticRaiseDeps,
  input: RaiseAcousticInput,
): Promise<RaiseAcousticOutcome> {
  if (!shouldRaiseAcousticIncident(input.signal)) {
    return { raised: false, reason: "below-threshold" };
  }

  const stage = ACOUSTIC_RAISE_STAGE;
  const entry: AuditEntry = { stage, at: input.now, cause: ACOUSTIC_CAUSE };

  const { id } = await deps.createIncidentAtStage({
    circleId: input.circleId,
    anchorId: input.anchorId,
    stage,
    cause: ACOUSTIC_CAUSE,
    auditTrail: [entry],
    ...(input.simulated !== undefined ? { simulated: input.simulated } : {}),
  });

  // STAGE_2 side-effect: the gentle device chime (R12.2).
  const effect: StageSideEffect = {
    incidentId: id,
    anchorId: input.anchorId,
    stage,
    kind: sideEffectForStage(stage),
  };
  await deps.performSideEffect(effect);

  // Schedule the STAGE_3 advance. STAGE_2 is never terminal, so this is always
  // present; the id matches what a STAGE_1-opened incident would use.
  const target = nextStage(stage);
  if (target === null) {
    // Unreachable for STAGE_2; kept exhaustive for type-safety.
    throw new Error("STAGE_2 unexpectedly has no next stage");
  }
  const scheduled: ScheduledAdvance = {
    jobId: escalationJobId(id, stageNumber(target)),
    targetStage: target,
    delayMs: input.stageIntervalMs,
    data: { incidentId: id, targetStage: target },
  };
  await deps.scheduleAdvance(scheduled);

  return { raised: true, incidentId: id, stage, auditTrail: [entry], effect, scheduled };
}
