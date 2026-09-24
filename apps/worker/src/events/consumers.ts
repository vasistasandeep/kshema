/**
 * Event consumers.
 *
 * `apps/api` is a *producer*: its routes emit domain events onto a single
 * BullMQ queue (`EVENTS_QUEUE_NAME`, default `sentinel-events`) where each job's
 * `name` is the event name and its `data` is `{ name, payload }` — see
 * `apps/api/src/plugins/events.ts`.
 *
 * This worker consumes that queue and *routes* each event to the queue/handler
 * that owns it. The routing table below is the alignment point between producer
 * and consumer: the event names and payload shape here mirror the API's
 * `SentinelEventName` / `SentinelEvent<T>`.
 *
 * Foundation scope (task 8.1): the handler bodies are stubs that log and no-op.
 * Later tasks replace them with real routing — e.g. `telemetry.received` /
 * `ghost.received` feed the rhythm/resolution logic that can *confirm a morning
 * routine* and prevent escalation (R5.6, R6.4, R6.5; task 9.1).
 */
import type { ResolutionSource } from "@kshema/database";

import type { QueueName } from "../queues/definitions.js";
import type { ProcessorContext } from "../jobs/registry.js";
import {
  createTelemetryReceivedHandler,
  createGhostReceivedHandler,
  createInMemoryGraceCheckStore,
  type GraceCheckStore,
} from "../personas/rhythm-eval.js";
import {
  handoffToShadowSos,
  resolveIncident,
  type ResolutionDeps,
} from "../resolution/resolve.js";

/**
 * The domain events the API produces. Mirrors `SentinelEventName` in
 * `apps/api/src/plugins/events.ts` — keep the two in sync.
 */
export type SentinelEventName =
  | "telemetry.received"
  | "ghost.received"
  | "incident.resolved"
  | "sos.triggered";

/** Envelope shape the API enqueues (`SentinelEvent<T>` in the API). */
export interface SentinelEvent<T = unknown> {
  name: SentinelEventName;
  payload: T;
}

/** A handler for one event name. */
export type EventHandler = (
  event: SentinelEvent,
  ctx: ProcessorContext,
) => Promise<unknown>;

/** Maps each event to the worker queue that ultimately owns its follow-up work. */
export const EVENT_TARGET_QUEUE: Record<SentinelEventName, QueueName> = {
  // Telemetry + ghost signals feed rhythm evaluation and can confirm a routine
  // (which the resolution path uses to prevent escalation). Routed to
  // rhythm-eval for the confirming-signal check in task 9.1.
  "telemetry.received": "rhythm-eval",
  "ghost.received": "rhythm-eval",
  // Resolution and SOS events feed the resolution queue (task 10.3 / 10.5).
  "incident.resolved": "resolution",
  "sos.triggered": "resolution",
};

/**
 * Build a stub handler that logs the routed event and no-ops.
 */
function makeStubHandler(event: SentinelEventName, todo: string): EventHandler {
  return async (received, ctx) => {
    // TODO(<see `todo`>): route to the owning queue/handler for real.
    ctx.logger.info(
      `[worker:events] received "${received.name}" → target queue "${EVENT_TARGET_QUEUE[event]}" — stub no-op. ${todo}`,
    );
    return { stubbed: true, event: received.name };
  };
}

/** One handler per event name. Injectable/overridable (tests + later tasks). */
export type EventHandlerRegistry = Record<SentinelEventName, EventHandler>;

/**
 * Default stub handlers. `telemetry.received` / `ghost.received` are the two
 * this task must wire; the other two are stubbed here for completeness so the
 * consumer never drops a known event on the floor.
 */
export const defaultEventHandlers: EventHandlerRegistry = {
  "telemetry.received": makeStubHandler(
    "telemetry.received",
    "TODO(task 9.1): treat confirming telemetry (screen unlock / positive step delta / charger unplug) as a routine confirmation that prevents escalation.",
  ),
  "ghost.received": makeStubHandler(
    "ghost.received",
    "TODO(task 9.1): treat a Ghost_Signal as sufficient to confirm the morning routine (R6.4, R6.5).",
  ),
  "incident.resolved": makeStubHandler(
    "incident.resolved",
    "TODO(task 10.3): atomically resolve the incident and cancel its pending escalation job.",
  ),
  "sos.triggered": makeStubHandler(
    "sos.triggered",
    "TODO(task 10.5): hand the incident off to Shadow_SOS dispatch, bypassing timed advancement.",
  ),
};

/** Extract the incident id from an `incident.resolved` / `sos.triggered` payload. */
function extractIncidentId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  return typeof p.incidentId === "string" ? p.incidentId : null;
}

/**
 * Build the `incident.resolved` handler (task 10.3, R13.1–13.8).
 *
 * Routes the resolving event to {@link resolveIncident}, which performs the
 * atomic conditional OPEN→RESOLVED transition and cancels the pending
 * escalation job(s). Idempotent: a second resolving event for the same incident
 * finds no OPEN row and is a no-op. The resolution side effects live behind the
 * injected {@link ResolutionDeps} seams so this stays hermetic.
 *
 * The `source` is read from the payload (`source: ResolutionSource`), defaulting
 * to `WHATSAPP_RESPONSE` when the producer omits it (the conversational
 * check-in reply is the canonical resolution path, R13.5).
 */
export function createIncidentResolvedHandler(
  deps: ResolutionDeps,
  options?: { now?: () => number },
): EventHandler {
  const now = options?.now ?? (() => Date.now());
  return async (event: SentinelEvent, ctx: ProcessorContext) => {
    const incidentId = extractIncidentId(event.payload);
    if (!incidentId) {
      ctx.logger.warn(
        "[worker:events] incident.resolved missing incidentId — skipping",
      );
      return { resolved: false, reason: "no-incident-id" };
    }
    const p = event.payload as Record<string, unknown>;
    const source: ResolutionSource =
      typeof p.source === "string"
        ? (p.source as ResolutionSource)
        : "WHATSAPP_RESPONSE";
    const result = await resolveIncident(deps, {
      incidentId,
      source,
      now: now(),
    });
    ctx.logger.info(
      `[worker:events] incident.resolved ${incidentId} (source=${source}) → resolved=${result.resolved}`,
    );
    return {
      resolved: result.resolved,
      source: result.source,
      cancelledJobIds: result.cancelledJobIds,
    };
  };
}

/**
 * Build the `sos.triggered` handler (task 10.3, R13.9/R11.4).
 *
 * Routes the Shadow_SOS trigger to {@link handoffToShadowSos}, which performs
 * the atomic conditional OPEN→HANDED_OFF_SOS transition, cancels the pending
 * timed escalation job(s), and releases the authorized black boxes for the
 * incident's circle/anchor — bypassing (superseding) timed advancement.
 * Idempotent by the conditional transition's affected-row count.
 */
export function createSosTriggeredHandler(
  deps: ResolutionDeps,
  options?: { now?: () => number },
): EventHandler {
  const now = options?.now ?? (() => Date.now());
  return async (event: SentinelEvent, ctx: ProcessorContext) => {
    const incidentId = extractIncidentId(event.payload);
    const p =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    const circleId = typeof p.circleId === "string" ? p.circleId : null;
    const anchorId = typeof p.anchorId === "string" ? p.anchorId : null;
    if (!incidentId || !circleId || !anchorId) {
      ctx.logger.warn(
        "[worker:events] sos.triggered missing incidentId/circleId/anchorId — skipping",
      );
      return { handedOff: false, reason: "missing-address" };
    }
    const result = await handoffToShadowSos(deps, {
      incidentId,
      circleId,
      anchorId,
      now: now(),
    });
    ctx.logger.info(
      `[worker:events] sos.triggered ${incidentId} → handedOff=${result.handedOff}`,
    );
    return {
      handedOff: result.handedOff,
      cancelledJobIds: result.cancelledJobIds,
      releasedBlackBoxes: result.releasedBlackBoxes,
    };
  };
}

/**
 * Build the real event handlers (tasks 9.1 + 10.3).
 *
 * `telemetry.received` and `ghost.received` are wired to the confirming-signal
 * path: a screen unlock, positive step delta, charger unplug, or Ghost_Signal
 * arriving before the Grace_Deadline marks the pending grace-check confirmed and
 * prevents escalation (R5.6, R6.4, R6.5). The `store` MUST be the same store the
 * `rhythm-eval` processor reads, so the two share the pending state.
 *
 * `incident.resolved` and `sos.triggered` are wired to the resolution path
 * (R13): the former resolves the incident atomically and cancels its pending
 * escalation job(s); the latter hands the incident off to Shadow_SOS, releasing
 * black boxes and bypassing timed advancement. Both require injected
 * {@link ResolutionDeps} seams; when they are omitted (e.g. the default
 * hermetic construction) the two events fall back to their logging stubs so the
 * consumer never drops a known event on the floor.
 */
export function buildDefaultEventHandlers(options?: {
  store?: GraceCheckStore;
  resolution?: ResolutionDeps;
  now?: () => number;
}): EventHandlerRegistry {
  const store = options?.store ?? createInMemoryGraceCheckStore();
  const handlers: EventHandlerRegistry = {
    ...defaultEventHandlers,
    "telemetry.received": createTelemetryReceivedHandler({ store }),
    "ghost.received": createGhostReceivedHandler({ store }),
  };
  if (options?.resolution) {
    handlers["incident.resolved"] = createIncidentResolvedHandler(
      options.resolution,
      options.now ? { now: options.now } : undefined,
    );
    handlers["sos.triggered"] = createSosTriggeredHandler(
      options.resolution,
      options.now ? { now: options.now } : undefined,
    );
  }
  return handlers;
}

/** True when a job name off the events queue is a known Sentinel event. */
export function isSentinelEventName(name: string): name is SentinelEventName {
  return name in EVENT_TARGET_QUEUE;
}

/**
 * Build the processor for the shared events queue. It parses the job envelope,
 * verifies the event is known, and dispatches to the matching handler. Unknown
 * events are logged and skipped rather than throwing, so a producer that adds a
 * new event name never fails this consumer's jobs.
 */
export function createEventsQueueProcessor(
  handlers: EventHandlerRegistry,
): (job: { name: string; data: unknown }, ctx: ProcessorContext) => Promise<unknown> {
  return async (job, ctx) => {
    const name = job.name;
    if (!isSentinelEventName(name)) {
      ctx.logger.warn(
        `[worker:events] ignoring unknown event "${name}" off the events queue`,
      );
      return { ignored: true, event: name };
    }
    const data = (job.data ?? {}) as Partial<SentinelEvent>;
    const event: SentinelEvent = {
      name,
      payload: data.payload,
    };
    return handlers[name](event, ctx);
  };
}
