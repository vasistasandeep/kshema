/**
 * Wiring for the `rhythm-eval` processor and the confirming-signal event
 * handlers (task 9.1).
 *
 * This module glues the pure logic (`confirming-signal.ts`, `evaluators.ts`,
 * `grace-check-scheduler.ts`) to the worker's processor/handler contracts while
 * keeping every side effect behind an injectable seam. The default seams read
 * from / write to an in-memory store, so the factory is fully hermetic in
 * tests; production wiring can pass DB/queue-backed seams.
 *
 * Responsibilities:
 *  - `rhythm-eval` processor: on a `schedule-grace-check` job, compute and
 *    enqueue the nightly grace-check descriptor; on a `grace-check` job, read
 *    the pending state and — via persona evaluators — decide whether to open an
 *    incident, honoring routine confirmation (R5.6/R6.4/R6.5).
 *  - `telemetry.received` / `ghost.received` handlers: translate the event into
 *    a {@link ConfirmingSignal} and apply it to the pending grace-check,
 *    marking it confirmed (and thereby preventing escalation) when it beats the
 *    deadline.
 */

import type { Job } from "bullmq";

import type { ProcessorContext, JobProcessor } from "../jobs/registry.js";
import type {
  EventHandler,
  SentinelEvent,
} from "../events/consumers.js";
import {
  applyConfirmingSignal,
  createGraceCheckState,
  shouldEscalate,
  type ConfirmingSignal,
  type ConfirmingSignalType,
  type GraceCheckState,
} from "./confirming-signal.js";
import {
  evaluatePersonaModes,
  type AggregatePersonaEvaluation,
  type PersonaEvaluationInputs,
  type PersonaMode,
} from "./evaluators.js";
import {
  buildGraceCheckDescriptor,
  type GraceCheckDescriptor,
  type GraceCheckEnqueue,
  type GraceCheckScheduleInput,
} from "./grace-check-scheduler.js";
import type { SanctuaryGate } from "../sanctuary/gate.js";
import type { ShieldGate } from "../subscription/shield-gate.js";
import type { CoLivingConfirmationGate } from "../coliving/rhythm-gate.js";

/** Job names the `rhythm-eval` queue understands. */
export type RhythmEvalJobName = "schedule-grace-check" | "grace-check";

/** Payload of a `schedule-grace-check` job. */
export interface ScheduleGraceCheckJobData extends GraceCheckScheduleInput {}

/** Payload of a `grace-check` job (fires at the Grace_Deadline). */
export interface GraceCheckJobData {
  anchorId: string;
  serviceDay: string;
  /**
   * The Circle the Anchor belongs to. Used ONLY to consult the Shield_Paused
   * tier gate (R20.5) on the routine path. Optional so existing callers and the
   * hermetic default remain backwards-compatible; when omitted the shield gate
   * is not consulted (no suppression).
   */
  circleId?: string;
  /** Enabled persona modes for the Anchor (empty/undefined ⇒ Elderly_Care). */
  enabledModes?: PersonaMode[];
  /** Per-mode evaluation inputs gathered at fire time. */
  personaInputs: PersonaEvaluationInputs;
}

/**
 * Store of pending grace-check states, keyed by the deterministic grace-check
 * job id. The seam is intentionally tiny; the default is an in-memory `Map` so
 * the processor + handlers can be exercised end-to-end without Redis/DB.
 */
export interface GraceCheckStore {
  get(jobId: string): GraceCheckState | undefined;
  set(state: GraceCheckState): void;
}

/** Build a default in-memory store keyed by grace-check job id. */
export function createInMemoryGraceCheckStore(): GraceCheckStore & {
  readonly map: Map<string, GraceCheckState>;
} {
  const map = new Map<string, GraceCheckState>();
  const keyOf = (anchorId: string, serviceDay: string): string =>
    `${anchorId}::${serviceDay}`;
  return {
    map,
    get: (key) => map.get(key),
    set: (state) => {
      map.set(keyOf(state.anchorId, state.serviceDay), state);
    },
  };
}

/** Key helper mirrored by the in-memory store, so callers can look states up. */
export function graceCheckStateKey(
  anchorId: string,
  serviceDay: string,
): string {
  return `${anchorId}::${serviceDay}`;
}

/** Side-effect seams for the rhythm-eval wiring; all injectable. */
export interface RhythmEvalDeps {
  /** Enqueue a computed grace-check descriptor (BullMQ add in prod). */
  enqueueGraceCheck: GraceCheckEnqueue;
  /** Pending grace-check state store. */
  store: GraceCheckStore;
  /**
   * Open a Safety_Incident for the Anchor. Injected so tests observe the
   * decision without touching the escalation queue. Only called when persona
   * evaluation says to escalate AND the routine is unconfirmed.
   */
  openIncident: (input: {
    anchorId: string;
    serviceDay: string;
    evaluation: AggregatePersonaEvaluation;
  }) => Promise<void>;
  /**
   * Optional Sanctuary Mode suspension gate (R34.2). Consulted BEFORE opening
   * any incident: if Sanctuary is active for the Anchor, routine evaluation,
   * WhatsApp pings, and ALL escalation stages are suppressed — no incident
   * opens. Omitted ⇒ no suppression (backwards-compatible default). Because the
   * gate only suppresses incident opening it never touches Vitality_Streak, so
   * the streak is preserved across the window (R34.5).
   */
  sanctuaryGate?: SanctuaryGate;
  /**
   * Optional Shield_Paused subscription-tier gate (R20.5). Consulted BEFORE
   * opening a ROUTINE incident: if the Circle's tier is SHIELD_PAUSED, the
   * scheduled grace check, WhatsApp ping, delayed escalation advancement, and
   * IVR/dispatch are all suppressed — no routine incident opens and no stage
   * fires. TRIAL and PRO keep full capabilities (R20.2). Omitted ⇒ no
   * suppression (backwards-compatible default).
   *
   * EMERGENCY BOUNDARY (R20.3/R20.5): this gate is consulted ONLY on the
   * routine grace-check path here. It is NEVER consulted on Shadow_SOS,
   * acoustic-distress, or hardware-duress entry points — those live in the
   * resolution/SOS path and must keep functioning even while Shield_Paused. The
   * gate is only reached when a `circleId` is present on the grace-check job;
   * emergency entry points carry no such consult.
   */
  shieldGate?: ShieldGate;
  /**
   * Optional co-living confirmation gate (R35.2). Consulted while deciding
   * whether the morning routine is confirmed for a co-living Anchor. It folds
   * the shared-household Ghost_Signal attribution + individual-signal
   * requirement (see `coliving/attribution.ts`) behind an injectable seam that
   * keeps household lookup hermetic. When it reports the routine confirmed, that
   * OUTCOME is OR'd into the existing confirmation flag additively — so a shared
   * household signal can confirm a non-independent Anchor, while an Anchor that
   * requires independent confirmation is only confirmed by its own screen-unlock
   * / step-delta (the R35.2 guard). Omitted ⇒ no co-living override
   * (backwards-compatible: single-occupant behavior is unchanged).
   */
  coLivingGate?: CoLivingConfirmationGate;
}

/**
 * Map a `telemetry.received` payload to a {@link ConfirmingSignal}, or `null`
 * when the payload carries no confirming evidence.
 *
 * The mapping is tolerant of the not-yet-finalized telemetry payload shape
 * (task 5.1): it reads the passive signals named in R5.1 — screen unlock, step
 * delta, charger/plug state — and picks the strongest confirming signal present.
 * A positive `stepDelta` confirms; a charger *unplug* (plugged transitioning
 * to false, or an explicit `chargerUnplugged` flag) confirms.
 */
export function telemetryToConfirmingSignal(
  payload: unknown,
): ConfirmingSignal | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  const at =
    typeof p.at === "number"
      ? p.at
      : typeof p.capturedAt === "number"
        ? p.capturedAt
        : typeof p.receivedAt === "number"
          ? p.receivedAt
          : Date.now();

  let type: ConfirmingSignalType | null = null;
  let stepDelta: number | undefined;

  if (p.screenUnlock === true) {
    type = "screen_unlock";
  } else if (typeof p.stepDelta === "number" && p.stepDelta > 0) {
    type = "step_delta";
    stepDelta = p.stepDelta;
  } else if (p.chargerUnplugged === true || p.chargerUnplug === true) {
    type = "charger_unplug";
  }

  if (type === null) return null;
  return { type, at, ...(stepDelta !== undefined ? { stepDelta } : {}) };
}

/**
 * Map a `ghost.received` payload to a Ghost_Signal {@link ConfirmingSignal}.
 * Any recorded Ghost_Signal is sufficient to confirm the morning routine
 * (R6.4/R6.5), so this always yields a `ghost_signal` confirming signal.
 */
export function ghostToConfirmingSignal(payload: unknown): ConfirmingSignal {
  const p =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const at =
    typeof p.at === "number"
      ? p.at
      : typeof p.recordedAt === "number"
        ? p.recordedAt
        : Date.now();
  return { type: "ghost_signal", at };
}

/** Extract `{ anchorId, serviceDay }` addressing from an event payload. */
function extractCheckAddress(
  payload: unknown,
): { anchorId: string; serviceDay: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.anchorId === "string" && typeof p.serviceDay === "string") {
    return { anchorId: p.anchorId, serviceDay: p.serviceDay };
  }
  return null;
}

/**
 * Apply a confirming signal (from telemetry or ghost) to the pending
 * grace-check for `(anchorId, serviceDay)`. Returns the resulting state, or
 * `null` when there is no pending check to confirm (nothing to do).
 *
 * Pure w.r.t. the store contract: it reads the current state, folds the signal
 * with {@link applyConfirmingSignal}, and persists the (possibly updated) state.
 */
export function confirmPendingCheck(
  store: GraceCheckStore,
  anchorId: string,
  serviceDay: string,
  signal: ConfirmingSignal,
): GraceCheckState | null {
  const key = graceCheckStateKey(anchorId, serviceDay);
  const current = store.get(key);
  if (!current) return null;
  const next = applyConfirmingSignal(current, signal);
  store.set(next);
  return next;
}

/** Build the `telemetry.received` handler wired to the confirming-signal path. */
export function createTelemetryReceivedHandler(
  deps: Pick<RhythmEvalDeps, "store">,
): EventHandler {
  return async (event: SentinelEvent, ctx: ProcessorContext) => {
    const address = extractCheckAddress(event.payload);
    const signal = telemetryToConfirmingSignal(event.payload);
    if (!address || !signal) {
      return { confirmed: false, reason: "no-confirming-telemetry" };
    }
    const state = confirmPendingCheck(
      deps.store,
      address.anchorId,
      address.serviceDay,
      signal,
    );
    if (!state) {
      return { confirmed: false, reason: "no-pending-check" };
    }
    ctx.logger.info(
      `[worker:rhythm-eval] telemetry ${signal.type} for ${address.anchorId}/${address.serviceDay} → confirmed=${state.confirmed}`,
    );
    return { confirmed: state.confirmed, signal: signal.type };
  };
}

/** Build the `ghost.received` handler wired to the confirming-signal path. */
export function createGhostReceivedHandler(
  deps: Pick<RhythmEvalDeps, "store">,
): EventHandler {
  return async (event: SentinelEvent, ctx: ProcessorContext) => {
    const address = extractCheckAddress(event.payload);
    if (!address) {
      return { confirmed: false, reason: "no-address" };
    }
    const signal = ghostToConfirmingSignal(event.payload);
    const state = confirmPendingCheck(
      deps.store,
      address.anchorId,
      address.serviceDay,
      signal,
    );
    if (!state) {
      return { confirmed: false, reason: "no-pending-check" };
    }
    ctx.logger.info(
      `[worker:rhythm-eval] ghost signal for ${address.anchorId}/${address.serviceDay} → confirmed=${state.confirmed}`,
    );
    return { confirmed: state.confirmed, signal: "ghost_signal" };
  };
}

/**
 * Build the `rhythm-eval` queue processor.
 *
 * Handles two job kinds:
 *  - `schedule-grace-check`: compute the grace-check descriptor, register a
 *    fresh (unconfirmed) pending state, and enqueue the delayed grace-check.
 *  - `grace-check`: run the enabled persona evaluators; if any triggers AND the
 *    routine is still unconfirmed, open an incident. A confirmed routine (R5.6/
 *    R6.4/R6.5) always prevents escalation regardless of evaluator output.
 */
export function createRhythmEvalProcessor(deps: RhythmEvalDeps): JobProcessor {
  return async (job: Job, ctx: ProcessorContext) => {
    const name = job.name as RhythmEvalJobName;

    if (name === "schedule-grace-check") {
      const data = job.data as ScheduleGraceCheckJobData;
      const descriptor: GraceCheckDescriptor =
        buildGraceCheckDescriptor(data);
      deps.store.set(
        createGraceCheckState({
          anchorId: data.anchorId,
          serviceDay: data.serviceDay,
          deadline: descriptor.fireAt,
        }),
      );
      await deps.enqueueGraceCheck(descriptor);
      ctx.logger.info(
        `[worker:rhythm-eval] scheduled grace-check ${descriptor.jobId} (delay=${descriptor.delayMs}ms)`,
      );
      return { scheduled: true, jobId: descriptor.jobId };
    }

    if (name === "grace-check") {
      const data = job.data as GraceCheckJobData;
      const key = graceCheckStateKey(data.anchorId, data.serviceDay);
      const state = deps.store.get(key);

      // A confirmed routine prevents any incident (R6.5). If the state is gone
      // treat it as unconfirmed (fail-safe: still evaluate personas).
      const stateConfirmed = state?.confirmed ?? false;

      // Co-living confirmation override (R35.2): for a co-living Anchor, a
      // shared household Ghost_Signal confirms a non-independent Anchor, while an
      // Anchor requiring independent confirmation is only confirmed by its own
      // screen-unlock / step-delta. The gate encapsulates household lookup +
      // attribution behind an injectable seam. This is ADDITIVE: it can only
      // turn an unconfirmed routine into confirmed (OR), never the reverse, so
      // the single-occupant path is unchanged when the gate is omitted.
      const coLivingConfirmed =
        !stateConfirmed && deps.coLivingGate
          ? await deps.coLivingGate.isRoutineConfirmed(
              data.anchorId,
              data.serviceDay,
            )
          : false;

      const confirmed = stateConfirmed || coLivingConfirmed;

      // Fold confirmation into the Elderly_Care input so the rhythm miss is
      // suppressed when the routine was confirmed.
      const personaInputs: PersonaEvaluationInputs = {
        ...data.personaInputs,
        ...(data.personaInputs.ELDERLY_CARE
          ? {
              ELDERLY_CARE: {
                ...data.personaInputs.ELDERLY_CARE,
                routineConfirmed:
                  data.personaInputs.ELDERLY_CARE.routineConfirmed || confirmed,
              },
            }
          : {}),
      };

      const evaluation = evaluatePersonaModes(data.enabledModes, personaInputs);

      const canEscalate =
        !confirmed &&
        (state ? shouldEscalate(state) : true) &&
        evaluation.escalate;

      // Sanctuary Mode gate (R34.2): consult the active SanctuarySchedule BEFORE
      // opening any incident. While a window is active for this Anchor, routine
      // evaluation, WhatsApp pings, and ALL escalation stages are suppressed —
      // no incident opens. Auto-resume is implicit and idempotent: once
      // now >= resumesAt the gate returns false with no state write (R34.4). The
      // gate never touches Vitality_Streak, so the streak is preserved (R34.5).
      if (canEscalate && deps.sanctuaryGate) {
        const suppressed = await deps.sanctuaryGate.shouldSuppressIncident(
          data.anchorId,
          Date.now(),
        );
        if (suppressed) {
          ctx.logger.info(
            `[worker:rhythm-eval] grace-check for ${data.anchorId}/${data.serviceDay} SUPPRESSED by Sanctuary Mode (R34.2)`,
          );
          return { escalated: false, suppressedBy: "sanctuary" as const };
        }
      }

      // Shield_Paused tier gate (R20.5): consult the Circle's Subscription tier
      // BEFORE opening a ROUTINE incident. While tier === SHIELD_PAUSED the
      // scheduled grace check, WhatsApp ping, delayed escalation advancement,
      // and IVR/dispatch are all suppressed — no routine incident opens and no
      // stage fires. TRIAL and PRO keep full capabilities (R20.2). Resumption
      // after SHIELD_PAUSED→PRO/TRIAL is automatic: the gate simply re-reads the
      // current tier on the next consult. This gate is ONLY consulted here on
      // the routine path and requires a `circleId`; emergency entry points
      // (Shadow_SOS, acoustic distress, hardware duress) never reach it, so they
      // keep functioning while Shield_Paused (R20.3/R20.5).
      if (canEscalate && deps.shieldGate && data.circleId) {
        const suspended = await deps.shieldGate.shouldSuspend(data.circleId);
        if (suspended) {
          ctx.logger.info(
            `[worker:rhythm-eval] grace-check for ${data.anchorId}/${data.serviceDay} SUPPRESSED by Shield_Paused tier (R20.5)`,
          );
          return { escalated: false, suppressedBy: "shield_paused" as const };
        }
      }

      if (canEscalate) {
        await deps.openIncident({
          anchorId: data.anchorId,
          serviceDay: data.serviceDay,
          evaluation,
        });
        ctx.logger.info(
          `[worker:rhythm-eval] grace-check for ${data.anchorId}/${data.serviceDay} escalating (modes=${evaluation.triggeredModes.join(",")})`,
        );
        return { escalated: true, triggeredModes: evaluation.triggeredModes };
      }

      ctx.logger.info(
        `[worker:rhythm-eval] grace-check for ${data.anchorId}/${data.serviceDay} withheld (confirmed=${confirmed})`,
      );
      return { escalated: false, confirmed };
    }

    ctx.logger.warn(`[worker:rhythm-eval] unknown job name "${job.name}"`);
    return { ignored: true, jobName: job.name };
  };
}
