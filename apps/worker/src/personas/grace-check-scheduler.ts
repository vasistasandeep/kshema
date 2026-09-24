/**
 * Nightly per-Anchor grace-check scheduling (R4.3, task 9.1).
 *
 * `rhythm-eval` computes an Anchor's adaptive Grace_Deadline and schedules a
 * single delayed `grace-check` job that fires at that deadline. If no confirming
 * signal has landed by then (see `confirming-signal.ts`), the grace-check opens
 * the incident.
 *
 * To keep this hermetic and testable without a live Redis, scheduling is split:
 *   - {@link buildGraceCheckDescriptor} is a **pure** function returning the
 *     job descriptor (deterministic `jobId`, `delayMs`, fire-at instant); tests
 *     assert on it directly.
 *   - {@link scheduleGraceCheck} performs the actual BullMQ `add`, but takes an
 *     injectable `enqueue` function so tests pass a spy instead of a real queue.
 */

import { computeGraceDeadline, type GraceDeadlineInput } from "../rhythm/engine.js";
import { graceCheckJobId } from "../jobs/job-id.js";

/** Inputs to schedule a nightly grace-check for one Anchor + service day. */
export interface GraceCheckScheduleInput {
  /** The Anchor whose routine is being watched. */
  anchorId: string;
  /** Local calendar day the check belongs to (e.g. `2025-01-31`). */
  serviceDay: string;
  /**
   * Epoch-millis for local midnight (00:00) of `serviceDay`. The Grace_Deadline
   * minute-of-day is added to this to get the absolute fire-at instant.
   */
  dayStart: number;
  /** Rhythm-engine inputs used to compute the Grace_Deadline. */
  deadline: GraceDeadlineInput;
  /** Current time as epoch-millis; used to compute the delay. */
  now: number;
}

/** A fully-resolved, enqueue-ready grace-check job descriptor. */
export interface GraceCheckDescriptor {
  /** Deterministic BullMQ job id (`rhythm:<anchor>:grace-check:<day>`). */
  jobId: string;
  /** Absolute instant (epoch-millis) the grace-check should fire. */
  fireAt: number;
  /** Delay from `now` until `fireAt`, clamped to `>= 0`. */
  delayMs: number;
  /** The computed Grace_Deadline minute-of-day (0..1439). */
  deadlineMinuteOfDay: number;
  /** Whether the deadline wrapped past the following midnight. */
  wrapsPastMidnight: boolean;
}

/** Milliseconds per minute — for converting minute-of-day to an offset. */
const MS_PER_MINUTE = 60_000;
/** Milliseconds per day — added when the deadline wraps past midnight. */
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * Build the grace-check job descriptor (pure).
 *
 * Computes the Grace_Deadline via the rhythm engine, maps its minute-of-day
 * onto an absolute instant relative to `dayStart`, and derives the delay from
 * `now`. When the deadline wraps past midnight (R4 raw > 1440), a full day is
 * added so the fire-at lands on the following calendar day. The delay is clamped
 * to `0` so a deadline already in the past enqueues an immediate check rather
 * than a negative delay.
 */
export function buildGraceCheckDescriptor(
  input: GraceCheckScheduleInput,
): GraceCheckDescriptor {
  const result = computeGraceDeadline(input.deadline);

  const wrapMs = result.wrapsPastMidnight ? MS_PER_DAY : 0;
  const fireAt =
    input.dayStart + result.minuteOfDay * MS_PER_MINUTE + wrapMs;

  const delayMs = Math.max(0, fireAt - input.now);

  return {
    jobId: graceCheckJobId(input.anchorId, input.serviceDay),
    fireAt,
    delayMs,
    deadlineMinuteOfDay: result.minuteOfDay,
    wrapsPastMidnight: result.wrapsPastMidnight,
  };
}

/**
 * A minimal enqueue seam. A real caller passes a closure over a BullMQ
 * `Queue.add(name, data, { jobId, delay })`; tests pass a spy. Keeping the seam
 * this narrow means the scheduler never imports BullMQ and stays unit-testable.
 */
export type GraceCheckEnqueue = (
  descriptor: GraceCheckDescriptor,
) => Promise<void>;

/**
 * Schedule the grace-check by building its descriptor and handing it to the
 * injected `enqueue`. Returns the descriptor so callers can log/audit it. Side
 * effects live entirely in `enqueue`, so this stays hermetic in tests.
 */
export async function scheduleGraceCheck(
  input: GraceCheckScheduleInput,
  enqueue: GraceCheckEnqueue,
): Promise<GraceCheckDescriptor> {
  const descriptor = buildGraceCheckDescriptor(input);
  await enqueue(descriptor);
  return descriptor;
}
