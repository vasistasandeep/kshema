/**
 * Four-stage escalation FSM (R12, task 10.1).
 *
 * The escalation ladder (design "Escalation State Machine" → "Job design") is
 * realized as BullMQ delayed jobs on the `escalation` queue. This module holds
 * the *pure/injectable* logic so it can be exercised end-to-end without a live
 * Redis or DB:
 *
 *   - {@link openIncident}: on a missed Grace_Deadline, create a Safety_Incident
 *     at STAGE_1, append `{stage, at, cause}` to the audit trail, send the
 *     conversational WhatsApp check-in via the `dispatch` queue, and schedule
 *     the STAGE_2 advance as a delayed job (`+stageInterval`) with the
 *     deterministic id `incident:<id>:stage2`.
 *   - {@link advanceIncident}: each `advance` job re-reads incident status; if
 *     RESOLVED or HANDED_OFF_SOS it EXITS (no side effects, no scheduling);
 *     otherwise it advances exactly one stage in strict order
 *     STAGE_1→2→3→4, performs that stage's side-effect (device chime, observer
 *     silent push, hyperlocal dispatch), appends to the audit trail, and — if
 *     not yet terminal — schedules the next advance `+stageInterval` with
 *     `incident:<id>:stage<next>`. STAGE_4 is terminal for timed advancement.
 *
 * Every side effect (Prisma read/write, BullMQ enqueue, dispatch) lives behind
 * an injectable seam ({@link EscalationDeps}) so the default registry wiring
 * and the unit tests stay hermetic. The 20-minute stage interval is a plain
 * parameter (`stageIntervalMs`) so Simulation_Mode (task 17.1) can compress it
 * without touching this logic.
 *
 * Scope note: this task implements only the timed-advancement FSM. Auto-
 * resolution / Shadow_SOS cancellation-by-id is task 10.3; this module simply
 * *reads* status and bails on a non-OPEN incident (defense-in-depth against the
 * race where a resolution lands between the delayed job firing and this read).
 */

import type { IncidentStage, IncidentStatus } from "@kshema/database";

import { escalationJobId, type StageNumber } from "../jobs/job-id.js";

/** The four escalation stages, in strict order (R12.5). */
export const STAGE_ORDER = [
  "STAGE_1_CONVERSATIONAL_WHATSAPP",
  "STAGE_2_GENTLE_DEVICE_CHIME",
  "STAGE_3_OBSERVER_SILENT_ALERT",
  "STAGE_4_HYPERLOCAL_DISPATCH",
] as const satisfies readonly IncidentStage[];

/** Map a stage enum to its numeric ordinal (1..4). */
export function stageNumber(stage: IncidentStage): StageNumber {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) {
    throw new Error(`unknown escalation stage "${stage}"`);
  }
  return (idx + 1) as StageNumber;
}

/**
 * The next stage after `stage`, or `null` when `stage` is the terminal
 * STAGE_4 (no further timed advancement). Never skips a stage (R12.5).
 */
export function nextStage(stage: IncidentStage): IncidentStage | null {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) {
    throw new Error(`unknown escalation stage "${stage}"`);
  }
  return STAGE_ORDER[idx + 1] ?? null;
}

/** One appended audit-trail entry (design: ordered array of `{stage, at, cause}`). */
export interface AuditEntry {
  /** The stage the incident is *in* after this transition. */
  stage: IncidentStage;
  /** Transition timestamp (epoch-millis). */
  at: number;
  /** Human/enum cause of the transition (R12.6). */
  cause: string;
}

/** The minimal incident shape the FSM reads back when advancing. */
export interface IncidentSnapshot {
  id: string;
  stage: IncidentStage;
  status: IncidentStatus;
}

/**
 * Describes a delayed `advance` job to enqueue onto the `escalation` queue.
 * The seam is deliberately narrow: production wiring closes over
 * `Queue.add("advance", data, { jobId, delay })`; tests pass a spy.
 */
export interface ScheduledAdvance {
  /** Deterministic BullMQ job id — `incident:<id>:stage<N>`. */
  jobId: string;
  /** The stage this job will advance the incident *into*. */
  targetStage: IncidentStage;
  /** Delay from enqueue time until the job fires (epoch-ms delta). */
  delayMs: number;
  /** Job payload the `advance` processor receives. */
  data: AdvanceJobData;
}

/** Payload of a delayed `advance` job. */
export interface AdvanceJobData {
  incidentId: string;
  /** The stage this job advances the incident *into* (for logging/idempotency). */
  targetStage: IncidentStage;
}

/** Injectable side-effect seams for the escalation FSM. */
export interface EscalationDeps {
  /**
   * Persist a brand-new incident at STAGE_1 with the given audit trail and
   * return its stable id. Production wiring performs the Prisma `create`; tests
   * pass a spy that returns a synthetic id.
   */
  createIncident: (input: {
    circleId: string;
    anchorId: string;
    cause: string;
    auditTrail: AuditEntry[];
    simulated?: boolean;
  }) => Promise<{ id: string }>;
  /**
   * Re-read an incident's current stage + status. Returns `null` if the
   * incident no longer exists. The FSM uses this to bail on a non-OPEN
   * incident (R12.2–12.5 / defense-in-depth against resolution races).
   */
  readIncident: (incidentId: string) => Promise<IncidentSnapshot | null>;
  /**
   * Persist a one-stage advance: set `stage` and append `entry` to the ordered
   * `auditTrail`. Production wiring performs the Prisma update (read-modify-
   * write or JSON append); tests observe the call.
   */
  applyAdvance: (input: {
    incidentId: string;
    stage: IncidentStage;
    entry: AuditEntry;
  }) => Promise<void>;
  /**
   * Enqueue the next delayed `advance` job. Production wiring closes over
   * `escalationQueue.add`. Idempotent by `jobId` (BullMQ ignores a duplicate
   * add), so re-enqueue is safe and cancellation-by-id (task 10.3) works.
   */
  scheduleAdvance: (advance: ScheduledAdvance) => Promise<void>;
  /**
   * Perform a stage's real-world side-effect. Enqueues onto the `dispatch`
   * queue (WhatsApp/chime/push/hyperlocal) in production; a spy in tests. The
   * FSM decides *which* effect fires per stage via {@link StageSideEffect}.
   */
  performSideEffect: (effect: StageSideEffect) => Promise<void>;
}

/** The side-effect a given stage triggers (design R12.1–12.4). */
export interface StageSideEffect {
  incidentId: string;
  anchorId?: string;
  /** The stage whose effect this is. */
  stage: IncidentStage;
  /** Discriminator naming the concrete action for the `dispatch` layer. */
  kind:
    | "whatsapp_checkin" // STAGE_1 (R12.1)
    | "device_chime" // STAGE_2 (R12.2)
    | "observer_silent_push" // STAGE_3 (R12.3)
    | "hyperlocal_dispatch"; // STAGE_4 (R12.4)
}

/** Map a stage to the side-effect kind it triggers on entry. */
export function sideEffectForStage(
  stage: IncidentStage,
): StageSideEffect["kind"] {
  switch (stage) {
    case "STAGE_1_CONVERSATIONAL_WHATSAPP":
      return "whatsapp_checkin";
    case "STAGE_2_GENTLE_DEVICE_CHIME":
      return "device_chime";
    case "STAGE_3_OBSERVER_SILENT_ALERT":
      return "observer_silent_push";
    case "STAGE_4_HYPERLOCAL_DISPATCH":
      return "hyperlocal_dispatch";
    default:
      throw new Error(`unknown escalation stage "${stage}"`);
  }
}

/** Inputs to open a fresh incident on a missed Grace_Deadline (R12.1). */
export interface OpenIncidentInput {
  circleId: string;
  anchorId: string;
  /** Cause recorded in the STAGE_1 audit entry (e.g. persona/trigger). */
  cause: string;
  /** Wall-clock now (epoch-millis); injected for deterministic tests. */
  now: number;
  /** Timed-advance interval; +20m in prod, compressed in Simulation_Mode. */
  stageIntervalMs: number;
  /** Flag the incident as simulated (Simulation_Mode, R25.4). */
  simulated?: boolean;
}

/** Result of {@link openIncident}. */
export interface OpenIncidentResult {
  incidentId: string;
  stage: IncidentStage;
  auditTrail: AuditEntry[];
  /** The STAGE_2 advance scheduled on open (never null — STAGE_1 is not terminal). */
  scheduled: ScheduledAdvance;
}

/**
 * Open a Safety_Incident at STAGE_1 (R12.1).
 *
 * Order of operations mirrors the design "Job design" bullet:
 *   1. create the incident at STAGE_1 with a STAGE_1 audit entry,
 *   2. send the conversational WhatsApp check-in via the dispatch seam,
 *   3. schedule the STAGE_2 advance as a delayed job (`incident:<id>:stage2`).
 *
 * The audit entry is built here (pure) and handed to `createIncident` so the
 * persisted trail starts with `{stage: STAGE_1, at, cause}`.
 */
export async function openIncident(
  deps: EscalationDeps,
  input: OpenIncidentInput,
): Promise<OpenIncidentResult> {
  const stage: IncidentStage = "STAGE_1_CONVERSATIONAL_WHATSAPP";
  const entry: AuditEntry = { stage, at: input.now, cause: input.cause };

  const { id } = await deps.createIncident({
    circleId: input.circleId,
    anchorId: input.anchorId,
    cause: input.cause,
    auditTrail: [entry],
    ...(input.simulated !== undefined ? { simulated: input.simulated } : {}),
  });

  // STAGE_1 side-effect: conversational WhatsApp check-in (R12.1).
  await deps.performSideEffect({
    incidentId: id,
    anchorId: input.anchorId,
    stage,
    kind: "whatsapp_checkin",
  });

  // Schedule the STAGE_2 advance. STAGE_1 is never terminal, so this is always
  // present.
  const target = nextStage(stage);
  if (target === null) {
    // Unreachable for STAGE_1; kept exhaustive for type-safety.
    throw new Error("STAGE_1 unexpectedly has no next stage");
  }
  const scheduled: ScheduledAdvance = {
    jobId: escalationJobId(id, stageNumber(target)),
    targetStage: target,
    delayMs: input.stageIntervalMs,
    data: { incidentId: id, targetStage: target },
  };
  await deps.scheduleAdvance(scheduled);

  return { incidentId: id, stage, auditTrail: [entry], scheduled };
}

/** Inputs to run one `advance` job (R12.2–12.5). */
export interface AdvanceInput {
  incidentId: string;
  /** Wall-clock now (epoch-millis); injected for deterministic tests. */
  now: number;
  /** Timed-advance interval; +20m in prod, compressed in Simulation_Mode. */
  stageIntervalMs: number;
  /** Cause recorded in the advance audit entry (defaults to a timed cause). */
  cause?: string;
}

/** Outcome of an {@link advanceIncident} call. */
export type AdvanceOutcome =
  | {
      /** The incident was non-OPEN (or gone): a strict no-op (R12.2–12.5). */
      advanced: false;
      reason: "not-open" | "not-found";
      status?: IncidentStatus;
    }
  | {
      advanced: true;
      /** Stage the incident moved *into*. */
      stage: IncidentStage;
      /** Audit entry appended for this transition. */
      entry: AuditEntry;
      /** The side-effect performed on entry. */
      effect: StageSideEffect;
      /** The next scheduled advance, or `null` if STAGE_4 (terminal). */
      scheduled: ScheduledAdvance | null;
    };

/**
 * Run a single `advance` job (R12.2–12.5).
 *
 * Re-reads the incident first. If it is not OPEN (RESOLVED / HANDED_OFF_SOS) or
 * no longer exists, this EXITS as a strict no-op — no side effect, no audit
 * append, no further scheduling. Otherwise it advances exactly one stage in
 * strict order, performs that stage's side-effect, appends the audit entry, and
 * (unless the new stage is the terminal STAGE_4) schedules the next advance
 * with the deterministic `incident:<id>:stage<next>` id.
 */
export async function advanceIncident(
  deps: EscalationDeps,
  input: AdvanceInput,
): Promise<AdvanceOutcome> {
  const current = await deps.readIncident(input.incidentId);
  if (current === null) {
    return { advanced: false, reason: "not-found" };
  }
  if (current.status !== "OPEN") {
    // RESOLVED or HANDED_OFF_SOS ⇒ no side effects, no scheduling (R12 / R13.8).
    return { advanced: false, reason: "not-open", status: current.status };
  }

  const target = nextStage(current.stage);
  if (target === null) {
    // Already at STAGE_4: terminal for timed advancement. Nothing to do.
    return {
      advanced: false,
      reason: "not-open",
      status: current.status,
    };
  }

  const cause = input.cause ?? `timed-advance:${current.stage}->${target}`;
  const entry: AuditEntry = { stage: target, at: input.now, cause };

  // Persist the one-stage advance + audit append before scheduling the next
  // job, so a crash between them re-enqueues (idempotent by jobId) rather than
  // advancing twice.
  await deps.applyAdvance({
    incidentId: current.id,
    stage: target,
    entry,
  });

  const effect: StageSideEffect = {
    incidentId: current.id,
    stage: target,
    kind: sideEffectForStage(target),
  };
  await deps.performSideEffect(effect);

  const following = nextStage(target);
  let scheduled: ScheduledAdvance | null = null;
  if (following !== null) {
    scheduled = {
      jobId: escalationJobId(current.id, stageNumber(following)),
      targetStage: following,
      delayMs: input.stageIntervalMs,
      data: { incidentId: current.id, targetStage: following },
    };
    await deps.scheduleAdvance(scheduled);
  }

  return { advanced: true, stage: target, entry, effect, scheduled };
}
