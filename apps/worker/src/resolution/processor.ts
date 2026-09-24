/**
 * `resolution` queue processor wiring (task 10.3).
 *
 * Glues the pure resolution logic (`resolve.ts`) to the worker's
 * {@link JobProcessor} contract while keeping every side effect behind
 * {@link ResolutionDeps}. The default deps are no-op/log seams so the registry
 * can be constructed without Redis/DB; production wiring (`app.ts`/`server.ts`)
 * overrides them with Prisma- and BullMQ-backed versions, and tests inject
 * spies.
 *
 * The processor understands two job kinds on the `resolution` queue:
 *   - `resolve`  — resolve an incident on an Auto_Resolution_Source
 *                  (payload {@link ResolveJobData}).
 *   - `handoff`  — hand an unresolved incident off to Shadow_SOS
 *                  (payload {@link HandoffJobData}).
 */

import type { Job } from "bullmq";

import type { ResolutionSource } from "@kshema/database";

import type { JobProcessor, ProcessorContext } from "../jobs/registry.js";
import {
  handoffToShadowSos,
  resolveIncident,
  type ResolutionDeps,
} from "./resolve.js";

/** Job names the `resolution` queue understands. */
export type ResolutionJobName = "resolve" | "handoff";

/** Payload of a `resolve` job (Auto_Resolution_Source cleared the alarm). */
export interface ResolveJobData {
  incidentId: string;
  source: ResolutionSource;
}

/** Payload of a `handoff` job (Shadow_SOS trigger). */
export interface HandoffJobData {
  incidentId: string;
  circleId: string;
  anchorId: string;
}

/** Dependencies for the resolution processor: resolution seams + clock. */
export interface ResolutionProcessorDeps extends ResolutionDeps {
  /** Injectable clock (epoch-millis); defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build the `resolution` queue processor from injectable deps. Pure w.r.t. the
 * seams in `deps`, so tests exercise resolve/handoff with spies and never touch
 * Redis/DB.
 */
export function createResolutionProcessor(
  deps: ResolutionProcessorDeps,
): JobProcessor {
  const now = deps.now ?? (() => Date.now());

  return async (job: Job, ctx: ProcessorContext) => {
    const name = job.name as ResolutionJobName;

    if (name === "resolve") {
      const data = job.data as ResolveJobData;
      const result = await resolveIncident(deps, {
        incidentId: data.incidentId,
        source: data.source,
        now: now(),
      });
      ctx.logger.info(
        `[worker:resolution] resolve ${data.incidentId} (source=${data.source}) → resolved=${result.resolved}` +
          (result.resolved
            ? `; cancelled ${result.cancelledJobIds.length} pending job(s)`
            : " (idempotent no-op)"),
      );
      return {
        resolved: result.resolved,
        source: result.source,
        cancelledJobIds: result.cancelledJobIds,
      };
    }

    if (name === "handoff") {
      const data = job.data as HandoffJobData;
      const result = await handoffToShadowSos(deps, {
        incidentId: data.incidentId,
        circleId: data.circleId,
        anchorId: data.anchorId,
        now: now(),
      });
      ctx.logger.info(
        `[worker:resolution] shadow-sos handoff ${data.incidentId} → handedOff=${result.handedOff}` +
          (result.handedOff
            ? `; cancelled ${result.cancelledJobIds.length} pending job(s); released black boxes`
            : " (idempotent no-op)"),
      );
      return {
        handedOff: result.handedOff,
        cancelledJobIds: result.cancelledJobIds,
        releasedBlackBoxes: result.releasedBlackBoxes,
      };
    }

    ctx.logger.warn(`[worker:resolution] unknown job name "${job.name}"`);
    return { ignored: true, jobName: job.name };
  };
}
