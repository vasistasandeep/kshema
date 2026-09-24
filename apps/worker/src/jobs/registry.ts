/**
 * Job processor registry.
 *
 * Each of the five queues has exactly one processor function: an async handler
 * that BullMQ invokes per job. This module holds the registry contract plus the
 * *stub* processors that the foundation ships with. The stubs log and no-op so
 * the worker boots, consumes, and shuts down cleanly today; each carries a TODO
 * pointing at the later task that replaces it with real business logic.
 *
 * A processor is registered per `QueueName`; the worker app factory
 * (`app.ts`) wires each registered processor into a BullMQ `Worker`. Later
 * tasks replace a stub by exporting a real processor and swapping it into
 * `defaultProcessorRegistry` (or by injecting an override registry into the
 * factory, which is how tests avoid real side-effects).
 */
import type { Job } from "bullmq";

import type { QueueName } from "../queues/definitions.js";
import type { PrismaClient } from "@kshema/database";
import {
  createRhythmEvalProcessor,
  createInMemoryGraceCheckStore,
  type GraceCheckStore,
  type RhythmEvalDeps,
} from "../personas/rhythm-eval.js";
import {
  createEscalationProcessor,
  type EscalationProcessorDeps,
} from "../escalation/processor.js";
import {
  createResolutionProcessor,
  type ResolutionProcessorDeps,
} from "../resolution/processor.js";
import {
  createDispatchProcessor,
  type DispatchProcessorDeps,
} from "../dispatch/index.js";
import {
  createVitalityProcessor,
  type VitalityProcessorDeps,
} from "../vitality/processor.js";
import { emptyStreakState } from "../vitality/streak.js";

/**
 * Context handed to every processor. Shared, injectable dependencies live here
 * so processors stay pure-ish and unit-testable without reaching for globals.
 */
export interface ProcessorContext {
  /** Shared Prisma client (the `@kshema/database` singleton by default). */
  prisma: PrismaClient;
  /** Structured logger; defaults to `console`. */
  logger: Pick<Console, "info" | "warn" | "error">;
}

/** A single queue's job processor. */
export type JobProcessor = (
  job: Job,
  ctx: ProcessorContext,
) => Promise<unknown>;

/** One processor per queue. */
export type ProcessorRegistry = Record<QueueName, JobProcessor>;

/**
 * Build a stub processor that logs the received job and no-ops. The `todo`
 * string names the task that will implement the real behavior.
 */
function makeStubProcessor(queue: QueueName, todo: string): JobProcessor {
  return async (job, ctx) => {
    // TODO(<see `todo`>): replace this stub with the real processor.
    ctx.logger.info(
      `[worker:${queue}] stub processed job "${job.name}" (id=${job.id}) — no-op. ${todo}`,
    );
    return { stubbed: true, queue, jobName: job.name };
  };
}

/**
 * Build a `rhythm-eval` processor from side-effect seams (task 9.1).
 *
 * The processor computes/schedules the nightly grace-check and, at deadline,
 * runs the persona evaluators to decide whether to open an incident — honoring
 * routine confirmation (R5.6/R6.4/R6.5). All side effects (enqueue, incident
 * open, state store) are injected so the default registry and tests stay
 * hermetic. The `store` is shared with the confirming-signal event handlers so
 * a confirming telemetry/ghost signal mutates the same pending state the
 * grace-check later reads.
 */
export function buildRhythmEvalProcessor(deps: RhythmEvalDeps): JobProcessor {
  return createRhythmEvalProcessor(deps);
}

/**
 * Build an `escalation` processor from side-effect seams (task 10.1).
 *
 * The processor opens incidents at STAGE_1 and advances them one stage at a
 * time on delayed `advance` jobs (R12). All side effects (incident create/read/
 * update, delayed-job enqueue, dispatch of the per-stage effect) are injected
 * so the default registry and tests stay hermetic. The 20-minute stage interval
 * is injectable so Simulation_Mode (task 17.1) can compress it.
 */
export function buildEscalationProcessor(
  deps: EscalationProcessorDeps,
): JobProcessor {
  return createEscalationProcessor(deps);
}

/**
 * Build a `resolution` processor from side-effect seams (task 10.3).
 *
 * The processor resolves incidents on any Auto_Resolution_Source (atomic
 * conditional OPEN→RESOLVED + cancel pending escalation jobs, R13.1–13.8) and
 * hands unresolved incidents off to Shadow_SOS (OPEN→HANDED_OFF_SOS + cancel
 * timed jobs + release authorized black boxes, R13.9/R11.4). All side effects
 * (conditional Prisma update, delayed-job removal, black-box release) are
 * injected so the default registry and tests stay hermetic.
 */
export function buildResolutionProcessor(
  deps: ResolutionProcessorDeps,
): JobProcessor {
  return createResolutionProcessor(deps);
}

/**
 * Build a `dispatch` processor from side-effect seams (task 12.2).
 *
 * The processor turns each escalation stage's side-effect into concrete carrier
 * calls behind the injected {@link CarrierAdapter}: STAGE_1 WhatsApp check-in,
 * and — at STAGE_4 — the AMD + Interactive_Voice_Handshake with exponential-
 * backoff retry and failover across the ordered contact list (R31), appending
 * the DTMF timestamp + AMD diagnostic to the incident audit trail (R31.4). All
 * side effects (carrier gateway, audit append) are injected so the default
 * registry and tests stay hermetic (tests inject a MockCarrierAdapter with a
 * scripted VoicePlan).
 */
export function buildDispatchProcessor(
  deps: DispatchProcessorDeps,
): JobProcessor {
  return createDispatchProcessor(deps);
}

/**
 * Build a `vitality` processor from side-effect seams (task 14.1).
 *
 * On a confirmed morning Routine_Rhythm the processor emits a Vitality_Pulse per
 * Observer (Anchor preferred name + confirmation time in the Anchor timezone +
 * step/weather context, R7.1/R7.2), records a `VitalityPulseLog` (R7.5), and
 * increments the Circle Vitality_Streak once per Anchor-tz day (R22.2). It also
 * preserves the streak on a delayed / no-crisis resolution (R22.4) and applies a
 * Streak_Freeze of up to 3 days on Traveling / battery-maintenance (R22.5). All
 * side effects (Observer fan-out, pulse log, streak load/save, push delivery)
 * are injected so the default registry and tests stay hermetic.
 *
 * CRITICAL INVARIANT (R22.6): the vitality processor is structurally separate
 * from escalation. Its deps contain NO incident/escalation seam, so a streak
 * reset or freeze can never trigger a Safety_Incident.
 */
export function buildVitalityProcessor(
  deps: VitalityProcessorDeps,
): JobProcessor {
  return createVitalityProcessor(deps);
}

/**
 * No-op default seams for the escalation FSM. Safe to construct without Redis/
 * DB: creates yield a synthetic id, reads report the incident missing (so a
 * stray `advance` is a strict no-op), and the enqueue/dispatch seams only log.
 * Production wiring (`app.ts`/`server.ts`) overrides these with Prisma- and
 * BullMQ-backed versions.
 */
function makeNoopEscalationDeps(
  logger: Pick<Console, "info" | "warn" | "error">,
): EscalationProcessorDeps {
  return {
    createIncident: async () => {
      logger.info(
        "[worker:escalation] no-op createIncident (production wiring persists via Prisma)",
      );
      return { id: `noop-incident-${Date.now()}` };
    },
    readIncident: async () => null,
    applyAdvance: async () => {
      /* no-op default: production wiring updates the incident via Prisma */
    },
    scheduleAdvance: async () => {
      /* no-op default: production wiring enqueues onto the escalation queue */
    },
    performSideEffect: async () => {
      /* no-op default: production wiring enqueues onto the dispatch queue */
    },
  };
}

/**
 * No-op default seams for the resolution worker. Safe to construct without
 * Redis/DB: the conditional transition reports 0 rows affected (so a stray
 * resolve/handoff is a strict no-op), and the cancel/release seams only log.
 * Production wiring (`app.ts`/`server.ts`) overrides these with a Prisma
 * `updateMany` (WHERE status='OPEN'), `escalationQueue.remove`, and a black-box
 * release update.
 */
function makeNoopResolutionDeps(
  logger: Pick<Console, "info" | "warn" | "error">,
): ResolutionProcessorDeps {
  return {
    conditionalTransition: async () => {
      logger.info(
        "[worker:resolution] no-op conditionalTransition (production wiring updates via Prisma updateMany WHERE status=OPEN)",
      );
      return { affected: 0 };
    },
    cancelJobs: async () => {
      /* no-op default: production wiring removes delayed jobs by jobId */
    },
    releaseBlackBoxes: async () => {
      /* no-op default: production wiring flips EncryptedBlackBox.released */
    },
  };
}

/**
 * No-op default seams for the dispatch worker. Safe to construct without a live
 * carrier/DB: the carrier logs and returns safe defaults (voice → unacknowledged
 * TIMEOUT, so an emergency is never *falsely* marked acknowledged), and the
 * audit-append seam only logs. Production wiring (`app.ts`/`server.ts`)
 * overrides `carrier` with a live/mock adapter and `appendAudit` with a
 * Prisma-backed JSON append onto `SafetyIncident.auditTrail` (R31.4).
 */
function makeNoopDispatchDeps(
  logger: Pick<Console, "info" | "warn" | "error">,
): DispatchProcessorDeps {
  return {
    carrier: {
      sendWhatsApp: async () => {
        logger.info(
          "[worker:dispatch] no-op sendWhatsApp (production wiring injects a carrier adapter)",
        );
        return { accepted: true };
      },
      sendSms: async () => {
        logger.info(
          "[worker:dispatch] no-op sendSms (production wiring injects a carrier adapter)",
        );
        return { accepted: true };
      },
      placeVoiceWithHandshake: async () => {
        logger.info(
          "[worker:dispatch] no-op placeVoiceWithHandshake (production wiring injects a carrier adapter)",
        );
        // Safe default: unacknowledged so nothing is ever falsely acknowledged.
        return { acknowledged: false, amdCode: "TIMEOUT" };
      },
    },
    appendAudit: async () => {
      /* no-op default: production wiring appends onto SafetyIncident.auditTrail */
    },
  };
}

/**
 * No-op default seams for the vitality worker. Safe to construct without DB/push:
 * the anchor/observer loads return empty defaults, streak load returns a fresh
 * empty state, and the log/save/deliver seams only log. Production wiring
 * (`app.ts`/`server.ts`) overrides these with Prisma-backed reads/writes over
 * `User`/`CircleMember`/`VitalityPulseLog`/`VitalityStreak` and a push transport.
 *
 * Deliberately contains NO incident/escalation seam (R22.6): the vitality queue
 * cannot open a Safety_Incident.
 */
function makeNoopVitalityDeps(
  logger: Pick<Console, "info" | "warn" | "error">,
): VitalityProcessorDeps {
  return {
    loadAnchorProfile: async (anchorId) => {
      logger.info(
        "[worker:vitality] no-op loadAnchorProfile (production wiring reads the User row)",
      );
      return { anchorId, preferredName: null, timezone: "Asia/Kolkata" };
    },
    listObservers: async () => {
      logger.info(
        "[worker:vitality] no-op listObservers (production wiring reads CircleMember OBSERVER/MUTUAL)",
      );
      return [];
    },
    recordPulseLog: async () => {
      /* no-op default: production wiring inserts a VitalityPulseLog row */
    },
    deliverPulse: async () => {
      /* no-op default: push transport is fulfilled by a later mobile/push task */
    },
    loadStreak: async () => emptyStreakState(),
    saveStreak: async () => {
      /* no-op default: production wiring upserts the VitalityStreak row */
    },
    resolveTimezone: async () => "Asia/Kolkata",
  };
}

/**
 * Build a default registry wired with a real `rhythm-eval` processor over the
 * provided (or a fresh in-memory) grace-check store. The remaining queues stay
 * stubbed until their tasks land. Enqueue/incident seams default to no-ops that
 * log, so this is safe to construct without Redis/DB; production wiring
 * (`app.ts`/`server.ts`) overrides the seams with queue/DB-backed versions.
 */
export function buildDefaultProcessorRegistry(options?: {
  store?: GraceCheckStore;
  rhythmEval?: Partial<RhythmEvalDeps>;
  escalation?: Partial<EscalationProcessorDeps>;
  resolution?: Partial<ResolutionProcessorDeps>;
  dispatch?: Partial<DispatchProcessorDeps>;
  vitality?: Partial<VitalityProcessorDeps>;
  logger?: Pick<Console, "info" | "warn" | "error">;
}): ProcessorRegistry {
  const logger = options?.logger ?? console;
  const store = options?.store ?? createInMemoryGraceCheckStore();
  const rhythmDeps: RhythmEvalDeps = {
    store,
    enqueueGraceCheck:
      options?.rhythmEval?.enqueueGraceCheck ??
      (async () => {
        /* no-op default: production wiring enqueues onto the rhythm-eval queue */
      }),
    openIncident:
      options?.rhythmEval?.openIncident ??
      (async () => {
        /* no-op default: production wiring enqueues onto the escalation queue */
      }),
  };
  const escalationDeps: EscalationProcessorDeps = {
    ...makeNoopEscalationDeps(logger),
    ...options?.escalation,
  };
  const resolutionDeps: ResolutionProcessorDeps = {
    ...makeNoopResolutionDeps(logger),
    ...options?.resolution,
  };
  const dispatchDeps: DispatchProcessorDeps = {
    ...makeNoopDispatchDeps(logger),
    ...options?.dispatch,
  };
  const vitalityDeps: VitalityProcessorDeps = {
    ...makeNoopVitalityDeps(logger),
    ...options?.vitality,
  };
  return {
    ...defaultProcessorRegistry,
    "rhythm-eval": buildRhythmEvalProcessor(rhythmDeps),
    escalation: buildEscalationProcessor(escalationDeps),
    resolution: buildResolutionProcessor(resolutionDeps),
    dispatch: buildDispatchProcessor(dispatchDeps),
    vitality: buildVitalityProcessor(vitalityDeps),
  };
}

/**
 * The default registry of stub processors. Every entry is a no-op that logs;
 * see each queue's TODO for the task that implements it.
 */
export const defaultProcessorRegistry: ProcessorRegistry = {
  "rhythm-eval": makeStubProcessor(
    "rhythm-eval",
    "TODO(task 8.2 / 9.1): compute Grace_Deadline and schedule the delayed grace-check.",
  ),
  escalation: makeStubProcessor(
    "escalation",
    "TODO(task 10.1): advance the four-stage escalation FSM and enqueue the next delayed stage.",
  ),
  // Fallback stub only; the real dispatch processor (task 12.2, WhatsApp/SMS/IVR
  // with retry + AMD/DTMF handshake) is wired via buildDispatchProcessor in
  // buildDefaultProcessorRegistry. Hyperlocal message-content assembly is task 13.x.
  dispatch: makeStubProcessor(
    "dispatch",
    "TODO(task 13.x): assemble hyperlocal message content from HyperlocalContactProfile.",
  ),
  resolution: makeStubProcessor(
    "resolution",
    "TODO(task 10.3): resolve incidents atomically and cancel pending escalation jobs.",
  ),
  vitality: makeStubProcessor(
    "vitality",
    "TODO(task 14.x): emit Vitality Pulses and increment streaks.",
  ),
};
