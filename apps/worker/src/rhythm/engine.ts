/**
 * Adaptive Bayesian rhythm engine (Requirement 4).
 *
 * A pure, deterministic, side-effect-free module that turns an Anchor's rolling
 * window of *observed* wake events into a daily `Grace_Deadline`. Every function
 * here is a plain function of its inputs so the `rhythm-eval` processor
 * (task 9.1) can inject and call it without any I/O, globals, or clock reads.
 *
 * Key semantic rules encoded here:
 *  - The baseline uses the **most recent 14** observed wake samples (R4.1) and
 *    computes mean + standard deviation as *minute-of-day* (R4.2).
 *  - The Grace_Deadline is `mean + 2*stdDev` plus a weekend offset (R4.3, R4.4)
 *    plus a fatigue offset (R4.5).
 *  - The baseline is derived **exclusively from observed samples**; there is no
 *    parameter, field, or branch that reads a statically configured wake time
 *    (R4.6). Callers physically cannot inject a static wake time.
 *  - Fewer than 14 samples is handled gracefully; a single sample yields
 *    stdDev = 0 (R4.7).
 *  - A verified wake event appends to the rolling window, evicting the oldest
 *    beyond 14, and recomputes the baseline (R4.8).
 */

/** The rolling wake-sample window size, in days (R4.1). */
export const ROLLING_WINDOW_DAYS = 14;

/** Default weekend grace offset in minutes (R4.4). */
export const DEFAULT_WEEKEND_OFFSET_MIN = 45;

/** Default fatigue grace offset in minutes (R4.5). */
export const DEFAULT_FATIGUE_OFFSET_MIN = 30;

/** Prior-day step ratio above which the fatigue offset applies (R4.5): 180%. */
export const FATIGUE_STEP_RATIO = 1.8;

/** Minutes in a day; used to document/handle past-midnight wraparound. */
export const MINUTES_PER_DAY = 1440;

/** The statistical baseline derived from the rolling wake-sample window. */
export interface RhythmBaseline {
  /** Mean wake time as minute-of-day over the window. */
  mean: number;
  /** Population standard deviation of wake time as minutes. `0` for <2 samples. */
  stdDev: number;
  /** Number of samples the baseline was computed from (0..14). */
  sampleCount: number;
}

/** Inputs to a daily Grace_Deadline computation (R4.3–R4.6). */
export interface GraceDeadlineInput {
  /** Mean wake minute-of-day (from {@link computeBaseline}). */
  mean: number;
  /** Standard deviation of wake minutes (from {@link computeBaseline}). */
  stdDev: number;
  /** Whether the target day is Saturday or Sunday (R4.4). */
  isWeekend: boolean;
  /** The Anchor's prior-day step count (R4.5). */
  priorDaySteps: number;
  /** The Anchor's 30-day average step count (R4.5). */
  avgStep30d: number;
  /** Weekend offset in minutes; defaults to 45 (R4.4). */
  weekendOffsetMin?: number;
  /** Fatigue offset in minutes; defaults to 30 (R4.5). */
  fatigueOffsetMin?: number;
}

/** A fully-broken-down Grace_Deadline result, for transparency/logging. */
export interface GraceDeadlineResult {
  /** `mean + 2*stdDev + weekendOffset + fatigueOffset`, un-wrapped (may exceed 1440). */
  rawMinuteOfDay: number;
  /** `rawMinuteOfDay mod 1440` — the clock minute-of-day (0..1439). */
  minuteOfDay: number;
  /** Whether the raw deadline landed on/after the following midnight. */
  wrapsPastMidnight: boolean;
  /** Weekend offset actually applied (0 or `weekendOffsetMin`). */
  appliedWeekendOffsetMin: number;
  /** Fatigue offset actually applied (0 or `fatigueOffsetMin`). */
  appliedFatigueOffsetMin: number;
}

/**
 * The minimal, observation-only slice of an `AdaptiveRhythmProfile` the engine
 * reads and updates. Note the deliberate absence of any "configured wake time"
 * field — the engine is structurally incapable of consuming one (R4.6).
 */
export interface RhythmProfileState {
  /** Rolling minute-of-day samples, oldest-first, capped at 14 (R4.1). */
  wakeSamples: number[];
  /** Cached mean wake minute-of-day (R4.2). */
  meanWakeMinute: number;
  /** Cached standard deviation of wake minutes (R4.2). */
  stdDevWakeMinute: number;
}

/**
 * Compute the rolling wake-time baseline (R4.1, R4.2, R4.7).
 *
 * Uses only the most recent {@link ROLLING_WINDOW_DAYS} samples. Mean and
 * standard deviation are computed as minute-of-day. The population standard
 * deviation (divide by N) is used so a single observed sample deterministically
 * yields `stdDev = 0` rather than a divide-by-zero (R4.7).
 *
 * Partial windows (1..13 samples) are handled by computing over exactly the
 * samples provided. An empty window yields `{ mean: 0, stdDev: 0, sampleCount: 0 }`;
 * callers should treat a zero-sample baseline as "not enough data yet" and
 * skip deadline evaluation until at least one verified wake event exists.
 *
 * This function never reads or infers a statically configured wake time — the
 * baseline is a pure function of the observed `wakeSamples` (R4.6).
 */
export function computeBaseline(wakeSamples: readonly number[]): RhythmBaseline {
  // Cap at the most recent 14 samples (rolling window). Samples are stored
  // oldest-first, so the window is the tail.
  const window =
    wakeSamples.length > ROLLING_WINDOW_DAYS
      ? wakeSamples.slice(wakeSamples.length - ROLLING_WINDOW_DAYS)
      : wakeSamples.slice();

  const sampleCount = window.length;
  if (sampleCount === 0) {
    return { mean: 0, stdDev: 0, sampleCount: 0 };
  }

  const sum = window.reduce((acc, v) => acc + v, 0);
  const mean = sum / sampleCount;

  if (sampleCount === 1) {
    // Single-sample variance is zero by definition (R4.7).
    return { mean, stdDev: 0, sampleCount };
  }

  const varianceSum = window.reduce((acc, v) => {
    const d = v - mean;
    return acc + d * d;
  }, 0);
  // Population standard deviation (÷N): deterministic and defined for N>=1.
  const stdDev = Math.sqrt(varianceSum / sampleCount);

  return { mean, stdDev, sampleCount };
}

/**
 * Compute the daily Grace_Deadline (R4.3–R4.6).
 *
 * Formula: `mean + 2*stdDev` (R4.3), plus the weekend offset when the day is
 * Saturday or Sunday (R4.4), plus the fatigue offset when the prior day's step
 * count exceeded 180% of the 30-day average (R4.5). No statically configured
 * wake time contributes to the result (R4.6) — there is simply no such input.
 *
 * Wraparound: the raw deadline can exceed 1440 (e.g. a very late mean plus wide
 * variance plus both offsets). `minuteOfDay` returns the value modulo 1440 so
 * downstream scheduling can map it onto a concrete clock time, while
 * `rawMinuteOfDay` and `wrapsPastMidnight` preserve the un-wrapped magnitude for
 * callers that need to schedule on the following calendar day.
 *
 * The fatigue comparison is strict (`>`), matching "exceeded 180%". When
 * `avgStep30d` is 0 (no baseline yet), any positive prior-day step count counts
 * as exceeding the threshold, while 0 prior-day steps does not.
 */
export function computeGraceDeadline(
  input: GraceDeadlineInput,
): GraceDeadlineResult {
  const {
    mean,
    stdDev,
    isWeekend,
    priorDaySteps,
    avgStep30d,
    weekendOffsetMin = DEFAULT_WEEKEND_OFFSET_MIN,
    fatigueOffsetMin = DEFAULT_FATIGUE_OFFSET_MIN,
  } = input;

  const base = mean + 2 * stdDev;

  const appliedWeekendOffsetMin = isWeekend ? weekendOffsetMin : 0;

  const fatigueThreshold = FATIGUE_STEP_RATIO * avgStep30d;
  const isFatigued = priorDaySteps > fatigueThreshold;
  const appliedFatigueOffsetMin = isFatigued ? fatigueOffsetMin : 0;

  const rawMinuteOfDay =
    base + appliedWeekendOffsetMin + appliedFatigueOffsetMin;

  // Normalize into a clock minute-of-day. `((x % D) + D) % D` keeps the result
  // in [0, 1440) even for defensively-negative inputs.
  const minuteOfDay =
    ((rawMinuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  return {
    rawMinuteOfDay,
    minuteOfDay,
    wrapsPastMidnight: rawMinuteOfDay >= MINUTES_PER_DAY,
    appliedWeekendOffsetMin,
    appliedFatigueOffsetMin,
  };
}

/**
 * Update the profile on a verified wake event (R4.8).
 *
 * Appends the new observed wake minute to the rolling window, evicts any
 * samples beyond the most recent {@link ROLLING_WINDOW_DAYS}, and recomputes the
 * cached mean/stdDev. Returns a new state object; the input is not mutated so
 * the function stays pure and safe to call from an idempotent processor.
 *
 * Only *verified* wake events should reach this function; clock-skewed or
 * out-of-window heartbeats are filtered upstream (R24 / design Property 27) and
 * must never be passed in as samples here.
 */
export function updateProfileOnWakeEvent(
  profile: RhythmProfileState,
  newWakeMinute: number,
): RhythmProfileState {
  const appended = [...profile.wakeSamples, newWakeMinute];
  const wakeSamples =
    appended.length > ROLLING_WINDOW_DAYS
      ? appended.slice(appended.length - ROLLING_WINDOW_DAYS)
      : appended;

  const baseline = computeBaseline(wakeSamples);

  return {
    wakeSamples,
    meanWakeMinute: baseline.mean,
    stdDevWakeMinute: baseline.stdDev,
  };
}
