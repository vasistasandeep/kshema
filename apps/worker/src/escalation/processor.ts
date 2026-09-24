/**
 * `escalation` queue processor wiring (task 10.1).
 *
 * Glues the pure FSM (`fsm.ts`) to the worker's {@link JobProcessor} contract
 * while keeping every side effect behind {@link EscalationDeps}. The default
 * deps are no-op/log seams so the registry can be constructed without Redis/DB;
 * production wiring (`app.ts`/`server.ts`) overrides them with Prisma- and
 * BullMQ-backed versions, and tests inject spies.
 *
 * The processor understands two job kinds on the `escalation` queue:
 *   - `open`   — open a fresh incident at STAGE_1 and schedule the STAGE_2
 *                advance (payload {@link OpenJobData}).
 *   - `advance`— run one timed stage advance (payload
 *                {@link import("./fsm.js").AdvanceJobData}).
 *
 * The 20-minute stage interval is read from an injected `stageIntervalMs` so
 * Simulation_Mode (task 17.1) can compress it without editing this file.
 */

import type { Job } from "bullmq";

import type { JobProcessor, ProcessorContext } from "../jobs/registry.js";
import {
  advanceIncident,
  openIncident,
  type AdvanceJobData,
  type EscalationDeps,
} from "./fsm.js";

/** Default +20-minute stage interval (R12.2–12.4). */
export const DEFAULT_STAGE_INTERVAL_MS = 20 * 60 * 1000;

/** Job names the `escalation` queue understands. */
export type EscalationJobName = "open" | "advance";

/** Payload of an `open` job (opens an incident at STAGE_1). */
export interface OpenJobData {
  circleId: string;
  anchorId: string;
  cause: string;
  simulated?: boolean;
}

/** Dependencies for the escalation processor: FSM seams + interval + clock. */
export interface EscalationProcessorDeps extends EscalationDeps {
  /** Timed-advance interval; defaults to {@link DEFAULT_STAGE_INTERVAL_MS}. */
  stageIntervalMs?: number;
  /** Injectable clock (epoch-millis); defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build the `escalation` queue processor from injectable deps. Pure w.r.t. the
 * seams in `deps`, so tests exercise the whole open→advance→…→STAGE_4 ladder
 * with spies and never touch Redis/DB.
 */
export function createEscalationProcessor(
  deps: EscalationProcessorDeps,
): JobProcessor {
  const stageIntervalMs = deps.stageIntervalMs ?? DEFAULT_STAGE_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());

  return async (job: Job, ctx: ProcessorContext) => {
    const name = job.name as EscalationJobName;

    if (name === "open") {
      const data = job.data as OpenJobData;
      const result = await openIncident(deps, {
        circleId: data.circleId,
        anchorId: data.anchorId,
        cause: data.cause,
        now: now(),
        stageIntervalMs,
        ...(data.simulated !== undefined ? { simulated: data.simulated } : {}),
      });
      ctx.logger.info(
        `[worker:escalation] opened incident ${result.incidentId} at ${result.stage}; scheduled ${result.scheduled.jobId} (delay=${result.scheduled.delayMs}ms)`,
      );
      return {
        opened: true,
        incidentId: result.incidentId,
        stage: result.stage,
        scheduledJobId: result.scheduled.jobId,
      };
    }

    if (name === "advance") {
      const data = job.data as AdvanceJobData;
      const outcome = await advanceIncident(deps, {
        incidentId: data.incidentId,
        now: now(),
        stageIntervalMs,
      });
      if (!outcome.advanced) {
        ctx.logger.info(
          `[worker:escalation] advance for ${data.incidentId} is a no-op (${outcome.reason}${outcome.status ? `, status=${outcome.status}` : ""})`,
        );
        return { advanced: false, reason: outcome.reason };
      }
      ctx.logger.info(
        `[worker:escalation] advanced ${data.incidentId} to ${outcome.stage} (effect=${outcome.effect.kind})${outcome.scheduled ? `; scheduled ${outcome.scheduled.jobId}` : "; terminal"}`,
      );
      return {
        advanced: true,
        stage: outcome.stage,
        effect: outcome.effect.kind,
        scheduledJobId: outcome.scheduled?.jobId ?? null,
      };
    }

    ctx.logger.warn(`[worker:escalation] unknown job name "${job.name}"`);
    return { ignored: true, jobName: job.name };
  };
}
