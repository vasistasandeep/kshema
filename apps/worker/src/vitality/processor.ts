/**
 * `vitality` queue processor wiring (task 14.1).
 *
 * Glues the pure Vitality_Pulse (`pulse.ts`) and Vitality_Streak (`streak.ts`)
 * logic to the worker's {@link JobProcessor} contract while keeping every side
 * effect behind injectable seams. The default seams are no-op/log so the
 * registry can be constructed without Redis/DB; production wiring
 * (`app.ts`/`server.ts`) overrides them with Prisma-backed versions, and tests
 * inject spies.
 *
 * CRITICAL INVARIANT (R22.6): the `vitality` queue is structurally separate
 * from the escalation/rhythm paths. This processor — and its whole dependency
 * closure (`pulse.ts`, `streak.ts`) — has NO seam that opens a Safety_Incident
 * and never imports the escalation queue. A streak reset or Streak_Freeze can
 * never trigger escalation.
 *
 * The processor understands three job kinds on the `vitality` queue:
 *   - `pulse`          — a confirmed morning routine: emit a Vitality_Pulse per
 *                        Observer (R7), record the log (R7.5), and increment the
 *                        Circle Vitality_Streak once for the day (R22.2).
 *   - `preserve`       — a delayed check / no-crisis resolution: preserve the
 *                        active streak, no increment/reset (R22.4).
 *   - `freeze`         — a "Traveling"/battery-maintenance status: apply a
 *                        Streak_Freeze of up to 3 days (R22.5).
 */

import type { Job } from "bullmq";

import type { JobProcessor, ProcessorContext } from "../jobs/registry.js";
import {
  emitVitalityPulse,
  type EmitVitalityPulseResult,
  type VitalityContext,
  type VitalityPulseDeps,
} from "./pulse.js";
import {
  applyStreakFreeze,
  incrementStreak,
  preserveStreak,
  serviceDayInTimezone,
  type StreakState,
} from "./streak.js";

/** Job names the `vitality` queue understands. */
export type VitalityJobName = "pulse" | "preserve" | "freeze";

/** Payload of a `pulse` job (a confirmed morning Routine_Rhythm). */
export interface PulseJobData {
  circleId: string;
  anchorId: string;
  /** Epoch-millis of the verified confirmation. */
  confirmedAtMillis: number;
  /** Step/weather context available at confirmation (R7.2). */
  context?: VitalityContext;
}

/** Payload of a `preserve` job (delayed check / no-crisis resolution — R22.4). */
export interface PreserveJobData {
  circleId: string;
}

/** Payload of a `freeze` job (Traveling / battery maintenance — R22.5). */
export interface FreezeJobData {
  circleId: string;
  anchorId: string;
  /** Requested freeze span in days; clamped to [1, 3]. */
  days?: number;
  /** Epoch-millis the freeze starts (defaults to `now`). */
  atMillis?: number;
}

/**
 * Streak persistence seams. Kept tiny and injectable: `loadStreak` reads the
 * current Circle Vitality_Streak (or a fresh empty state), `saveStreak`
 * persists the next state. Production wiring reads/writes the `VitalityStreak`
 * row; tests inject an in-memory map. NONE of these can open an incident (R22.6).
 */
export interface VitalityStreakDeps {
  loadStreak: (circleId: string) => Promise<StreakState>;
  saveStreak: (circleId: string, state: StreakState) => Promise<void>;
}

/**
 * Dependencies for the vitality processor: pulse seams + streak seams + clock.
 * There is deliberately NO `openIncident`/escalation seam here (R22.6).
 */
export interface VitalityProcessorDeps
  extends VitalityPulseDeps,
    VitalityStreakDeps {
  /** Injectable clock (epoch-millis); defaults to `Date.now`. */
  now?: () => number;
  /** Resolve the Anchor timezone for a Circle, for service-day computation. */
  resolveTimezone: (input: {
    circleId: string;
    anchorId: string;
  }) => Promise<string>;
}

/**
 * Build the `vitality` queue processor from injectable deps. Pure w.r.t. the
 * seams in `deps`, so tests exercise pulse emission + streak transitions with
 * spies and never touch Redis/DB.
 */
export function createVitalityProcessor(
  deps: VitalityProcessorDeps,
): JobProcessor {
  const now = deps.now ?? (() => Date.now());

  return async (job: Job, ctx: ProcessorContext) => {
    const name = job.name as VitalityJobName;

    if (name === "pulse") {
      const data = job.data as PulseJobData;

      // 1) Fan out a Vitality_Pulse per Observer + record the log (R7).
      const emit: EmitVitalityPulseResult = await emitVitalityPulse(deps, {
        circleId: data.circleId,
        anchorId: data.anchorId,
        confirmedAtMillis: data.confirmedAtMillis,
        ...(data.context !== undefined ? { context: data.context } : {}),
      });

      // 2) Increment the Circle Vitality_Streak once for the day (R22.2),
      //    idempotent per Anchor-tz calendar day.
      const timezone = await deps.resolveTimezone({
        circleId: data.circleId,
        anchorId: data.anchorId,
      });
      const day = serviceDayInTimezone(data.confirmedAtMillis, timezone);
      const current = await deps.loadStreak(data.circleId);
      const { state: next, incremented } = incrementStreak(current, day);
      if (incremented) {
        await deps.saveStreak(data.circleId, next);
      }

      ctx.logger.info(
        `[worker:vitality] pulse for ${data.anchorId}/${day} → ${emit.pulses.length} observer(s); streak=${next.count} (incremented=${incremented})`,
      );
      return {
        pulses: emit.pulses.length,
        logged: emit.logged,
        streakCount: next.count,
        incremented,
        day,
      };
    }

    if (name === "preserve") {
      const data = job.data as PreserveJobData;
      // R22.4: delayed check / no-crisis resolution preserves the streak.
      const current = await deps.loadStreak(data.circleId);
      const next = preserveStreak(current);
      // Preservation is a no-op on state; persist defensively for parity.
      await deps.saveStreak(data.circleId, next);
      ctx.logger.info(
        `[worker:vitality] preserve streak for ${data.circleId} → streak=${next.count} (unchanged)`,
      );
      return { preserved: true, streakCount: next.count };
    }

    if (name === "freeze") {
      const data = job.data as FreezeJobData;
      // R22.5: Streak_Freeze up to 3 days for Traveling / battery maintenance.
      const atMillis = data.atMillis ?? now();
      const timezone = await deps.resolveTimezone({
        circleId: data.circleId,
        anchorId: data.anchorId,
      });
      const startDay = serviceDayInTimezone(atMillis, timezone);
      const current = await deps.loadStreak(data.circleId);
      const next = applyStreakFreeze(current, startDay, data.days ?? 3);
      await deps.saveStreak(data.circleId, next);
      ctx.logger.info(
        `[worker:vitality] freeze streak for ${data.circleId} from ${startDay} → freezeUntil=${next.freezeUntil}`,
      );
      return {
        frozen: true,
        streakCount: next.count,
        freezeUntil: next.freezeUntil,
      };
    }

    ctx.logger.warn(`[worker:vitality] unknown job name "${job.name}"`);
    return { ignored: true, jobName: job.name };
  };
}
