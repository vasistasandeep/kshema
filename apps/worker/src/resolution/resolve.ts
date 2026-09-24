/**
 * Auto-resolution + Shadow_SOS handoff logic (R13, R11.4; task 10.3).
 *
 * The `resolution` queue owns the terminal transitions of a Safety_Incident:
 *
 *   - {@link resolveIncident}: on ANY Auto_Resolution_Source event (screen
 *     unlock, step delta, charger unplug, Ghost_Signal, WhatsApp response,
 *     Anchor dismissal, authorized Observer override — R13.1–13.7), perform an
 *     ATOMIC conditional transition `OPEN→RESOLVED` (a Prisma `updateMany`
 *     `WHERE status = 'OPEN'` that returns the affected-row count). Because the
 *     update is conditional, a second resolving event finds no OPEN row and is a
 *     strict no-op — resolution is idempotent (R13.8, Property 7). On a real
 *     transition it records `resolutionSource` + `resolvedAt` and cancels the
 *     pending delayed escalation job(s) by their deterministic `jobId`
 *     (`incident:<id>:stageN`). Cancellation is itself idempotent: removing an
 *     absent job is fine.
 *   - {@link handoffToShadowSos}: on a Shadow_SOS trigger for an unresolved
 *     incident (R13.9, R11.4), atomically transition `OPEN→HANDED_OFF_SOS`,
 *     cancel the pending timed escalation job(s), RELEASE the authorized black
 *     boxes for the incident's circle/anchor (set `released=true`), and bypass
 *     timed advancement. This SUPERSEDES timed stage advancement (Property 8).
 *
 * Every side effect (Prisma conditional update, BullMQ job removal, black-box
 * release) lives behind an injectable seam ({@link ResolutionDeps}) so the
 * default registry wiring and the unit tests stay hermetic. The cancellation
 * seam takes `jobId`s; the release seam takes `{ circleId, anchorId }` — the
 * same association the 6.2 black-box fetch route uses.
 *
 * Design references: "Auto-resolution cancellation (R13.8)" and "Shadow SOS
 * handoff (R11, R13.9)".
 */

import type { ResolutionSource } from "@kshema/database";

import { escalationJobId, type StageNumber } from "../jobs/job-id.js";

/** The stages a pending timed `advance` job can target (STAGE_2..STAGE_4). */
const CANCELLABLE_STAGE_NUMBERS: readonly StageNumber[] = [2, 3, 4];

/**
 * Deterministic ids of every delayed escalation `advance` job that could be
 * pending for an incident. Only STAGE_2..STAGE_4 are ever scheduled as delayed
 * jobs (STAGE_1 is opened synchronously; there is no `stage1` advance job).
 * Removing an id with no live job is a harmless no-op, so cancelling the whole
 * set is safe and keeps resolution/handoff independent of which stage is
 * currently pending (idempotent — R13.8).
 */
export function pendingEscalationJobIds(incidentId: string): string[] {
  return CANCELLABLE_STAGE_NUMBERS.map((stage) =>
    escalationJobId(incidentId, stage),
  );
}

/**
 * The set of {@link ResolutionSource} values that represent an
 * Auto_Resolution_Source clearing a false alarm (R13.1–13.7). `SHADOW_SOS_HANDOFF`
 * is deliberately excluded here: a Shadow_SOS is a *handoff*, not a resolution,
 * and flows through {@link handoffToShadowSos} instead.
 */
export const AUTO_RESOLUTION_SOURCES = [
  "SCREEN_UNLOCK", // R13.1
  "STEP_DELTA", // R13.2
  "CHARGER_UNPLUG", // R13.3
  "GHOST_SIGNAL", // R13.4
  "WHATSAPP_RESPONSE", // R13.5
  "ANCHOR_DISMISSAL", // R13.6
  "OBSERVER_OVERRIDE", // R13.7
  "CO_LIVING_PARTNER_CONFIRMED", // R35.4 (co-living partner confirmation)
  "RESPONDER_CONFIRMED", // R29.10 (on-scene responder confirmation)
] as const satisfies readonly ResolutionSource[];

/** True when `source` is a resolving Auto_Resolution_Source (not a handoff). */
export function isAutoResolutionSource(
  source: ResolutionSource,
): boolean {
  return (AUTO_RESOLUTION_SOURCES as readonly ResolutionSource[]).includes(
    source,
  );
}

/** Injectable side-effect seams for the resolution worker. */
export interface ResolutionDeps {
  /**
   * ATOMIC conditional transition of an incident from OPEN to `toStatus`,
   * recording `resolutionSource` + `resolvedAt`. MUST be a conditional update
   * scoped to `status = 'OPEN'` (Prisma `updateMany` WHERE status=OPEN) and
   * MUST return the number of rows affected: `1` on a real transition, `0` when
   * the incident was already terminal (RESOLVED/HANDED_OFF_SOS) or missing.
   * This count is what makes resolution/handoff idempotent (R13.8).
   */
  conditionalTransition: (input: {
    incidentId: string;
    toStatus: "RESOLVED" | "HANDED_OFF_SOS";
    resolutionSource: ResolutionSource;
    resolvedAt: number;
  }) => Promise<{ affected: number }>;
  /**
   * Cancel pending delayed escalation jobs by deterministic `jobId`. Production
   * wiring closes over `escalationQueue.remove(jobId)`. MUST be idempotent —
   * removing an absent job is a no-op (BullMQ returns without error).
   */
  cancelJobs: (jobIds: string[]) => Promise<void>;
  /**
   * Release the authorized Encrypted_Black_Box(es) for the incident's
   * circle/anchor (set `released = true`) — the same association the 6.2
   * black-box fetch route uses. Only invoked on Shadow_SOS handoff (R11.6/R13.9).
   */
  releaseBlackBoxes: (input: {
    circleId: string;
    anchorId: string;
  }) => Promise<void>;
}

/** Inputs to resolve an incident on an Auto_Resolution_Source (R13.1–13.8). */
export interface ResolveIncidentInput {
  incidentId: string;
  /** The Auto_Resolution_Source that cleared the alarm. */
  source: ResolutionSource;
  /** Wall-clock now (epoch-millis); injected for deterministic tests. */
  now: number;
}

/** Outcome of {@link resolveIncident}. */
export interface ResolveIncidentResult {
  /**
   * `true` iff this call performed the OPEN→RESOLVED transition. `false` when
   * the incident was already terminal/missing — a strict idempotent no-op
   * (R13.8).
   */
  resolved: boolean;
  /** The recorded Auto_Resolution_Source (echoed back for logging). */
  source: ResolutionSource;
  /** Deterministic job ids whose cancellation was requested (empty on no-op). */
  cancelledJobIds: string[];
}

/**
 * Resolve an incident on any Auto_Resolution_Source (R13.1–13.8).
 *
 * Order of operations mirrors the design "Auto-resolution cancellation":
 *   1. atomically transition `OPEN→RESOLVED` via the conditional seam,
 *      recording `resolutionSource` + `resolvedAt`;
 *   2. only if that transition actually happened (`affected === 1`), cancel the
 *      pending delayed escalation job(s) by deterministic `jobId`.
 *
 * When the transition affects 0 rows the incident was already RESOLVED /
 * HANDED_OFF_SOS (or gone): this is a no-op — no cancellation, no source
 * re-recording — which is exactly the idempotency guarantee (R13.8, Property 7).
 */
export async function resolveIncident(
  deps: ResolutionDeps,
  input: ResolveIncidentInput,
): Promise<ResolveIncidentResult> {
  const { affected } = await deps.conditionalTransition({
    incidentId: input.incidentId,
    toStatus: "RESOLVED",
    resolutionSource: input.source,
    resolvedAt: input.now,
  });

  if (affected === 0) {
    // Already terminal (RESOLVED / HANDED_OFF_SOS) or missing ⇒ idempotent no-op.
    return { resolved: false, source: input.source, cancelledJobIds: [] };
  }

  // Halt all pending Escalation_Stage advancements for this incident (R13.8).
  const cancelledJobIds = pendingEscalationJobIds(input.incidentId);
  await deps.cancelJobs(cancelledJobIds);

  return { resolved: true, source: input.source, cancelledJobIds };
}

/** Inputs to hand an incident off to Shadow_SOS dispatch (R13.9, R11.4). */
export interface HandoffToShadowSosInput {
  incidentId: string;
  /** The incident's circle + anchor (for black-box release). */
  circleId: string;
  anchorId: string;
  /** Wall-clock now (epoch-millis); injected for deterministic tests. */
  now: number;
}

/** Outcome of {@link handoffToShadowSos}. */
export interface HandoffToShadowSosResult {
  /**
   * `true` iff this call performed the OPEN→HANDED_OFF_SOS transition. `false`
   * when the incident was already terminal/missing (idempotent no-op).
   */
  handedOff: boolean;
  /** Deterministic job ids whose cancellation was requested. */
  cancelledJobIds: string[];
  /** `true` iff authorized black boxes were released this call. */
  releasedBlackBoxes: boolean;
}

/**
 * Hand an unresolved incident off to Shadow_SOS dispatch (R13.9, R11.4).
 *
 * Order of operations mirrors the design "Shadow SOS handoff":
 *   1. atomically transition `OPEN→HANDED_OFF_SOS` via the conditional seam,
 *      recording `SHADOW_SOS_HANDOFF` + `resolvedAt`;
 *   2. only if that transition actually happened, cancel the pending timed
 *      escalation job(s) and RELEASE the authorized black boxes for the
 *      incident's circle/anchor — bypassing timed advancement.
 *
 * This SUPERSEDES timed stage advancement: once the incident is HANDED_OFF_SOS,
 * every subsequent `advance` job re-reads a non-OPEN status and no-ops (R13.9,
 * Property 8). A second handoff (or a resolve after handoff) affects 0 rows and
 * is a no-op.
 */
export async function handoffToShadowSos(
  deps: ResolutionDeps,
  input: HandoffToShadowSosInput,
): Promise<HandoffToShadowSosResult> {
  const { affected } = await deps.conditionalTransition({
    incidentId: input.incidentId,
    toStatus: "HANDED_OFF_SOS",
    resolutionSource: "SHADOW_SOS_HANDOFF",
    resolvedAt: input.now,
  });

  if (affected === 0) {
    // Already terminal or missing ⇒ idempotent no-op.
    return {
      handedOff: false,
      cancelledJobIds: [],
      releasedBlackBoxes: false,
    };
  }

  // Cancel pending timed stage jobs and release authorized black boxes (R11.6).
  const cancelledJobIds = pendingEscalationJobIds(input.incidentId);
  await deps.cancelJobs(cancelledJobIds);
  await deps.releaseBlackBoxes({
    circleId: input.circleId,
    anchorId: input.anchorId,
  });

  return { handedOff: true, cancelledJobIds, releasedBlackBoxes: true };
}
