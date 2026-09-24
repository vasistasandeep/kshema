/**
 * Edge Acoustic Distress Detection — on-device classifier gate
 * (R10.1, R10.2, R19.4; task 22.3).
 *
 * The Acoustic_Distress_Classifier runs entirely on the Anchor device and
 * classifies short audio frames into distress categories — heavy impacts, glass
 * breakage, and vocal distress cues (R10.1). It processes audio **in memory
 * only** and NEVER writes audio to disk or transmits it off the device
 * (R10.2, R19.4). What ever leaves this module is a distilled numeric signal
 * (`{confidence, sustainedSec, motionlessSec}`) — never audio samples.
 *
 * The classifier model itself is native (a TFLite/Core ML tensor model on
 * device) and sits behind {@link AudioFrameClassifier}. This domain module owns
 * the *stateful gating* logic that turns a stream of per-frame classifications
 * into the distilled signal the Sentinel_Worker consumes (worker task 13.7,
 * `apps/worker/src/acoustic/raise.ts`): it tracks how long a distress category
 * has been *sustained* and pairs it with the device motionlessness reading, then
 * emits an {@link AcousticSignal} the worker gates on (confidence > 0.82,
 * sustained > 1.5s, motionless >= 30s). The thresholds are re-exported here for
 * the on-device pre-filter so we don't ship a signal the worker will always
 * reject, but the worker remains the authority (R10.3, R10.4).
 */

/** Distress categories the on-device classifier recognizes (R10.1). */
export type DistressCategory =
  | "HEAVY_IMPACT"
  | "GLASS_BREAKAGE"
  | "VOCAL_DISTRESS";

/** All recognized distress categories, for iteration/validation. */
export const DISTRESS_CATEGORIES: readonly DistressCategory[] = [
  "HEAVY_IMPACT",
  "GLASS_BREAKAGE",
  "VOCAL_DISTRESS",
] as const;

/**
 * The distilled signal emitted for the Sentinel_Worker (matches the worker's
 * `AcousticSignal` in `apps/worker/src/acoustic/raise.ts`). Contains NO audio —
 * only the classifier's confidence, how long the distress was sustained, and
 * how long the device has been motionless (R10.2, R19.4).
 */
export interface AcousticSignal {
  /** Winning distress category for the sustained window. */
  readonly category: DistressCategory;
  /** Peak classifier confidence over the sustained window, in [0, 1]. */
  readonly confidence: number;
  /** How long (seconds) the distress category was continuously sustained. */
  readonly sustainedSec: number;
  /** How long (seconds) the device has reported motionlessness. */
  readonly motionlessSec: number;
}

/**
 * Worker-authoritative gating thresholds, mirrored on-device as a pre-filter so
 * we never transmit a signal that would be rejected (R10.3, R10.4). Keep in
 * lockstep with `apps/worker/src/acoustic/raise.ts`.
 */
export const ACOUSTIC_CONFIDENCE_THRESHOLD = 0.82;
export const ACOUSTIC_SUSTAINED_THRESHOLD_SEC = 1.5;
export const ACOUSTIC_MOTIONLESS_THRESHOLD_SEC = 30;

/**
 * Native, in-memory audio classifier seam (R10.1, R10.2). Given a decoded audio
 * frame (raw PCM samples held only for the duration of the call) it returns a
 * per-frame category + confidence. Implementations MUST NOT persist or transmit
 * the samples. The domain layer only ever sees the returned scalar.
 */
export interface FrameClassification {
  readonly category: DistressCategory;
  readonly confidence: number;
}

export interface AudioFrameClassifier {
  /**
   * Classify one in-memory audio frame. The `samples` buffer is owned by the
   * caller and released immediately after; the classifier must copy nothing to
   * persistent storage (R10.2, R19.4).
   */
  classifyFrame(samples: Float32Array): FrameClassification | null;
}

/**
 * Reading of device motion, supplied by the platform accelerometer seam. The
 * gate pairs sustained acoustic distress with motionlessness (R10.3).
 */
export interface MotionState {
  /** Seconds the device has been continuously motionless (0 if moving). */
  readonly motionlessSec: number;
}

/**
 * Stateful gate that folds a stream of per-frame classifications into a
 * sustained-distress signal. It is pure w.r.t. its inputs (no I/O, no clock
 * reads — the caller passes `now` and motion), so it is fully unit-testable.
 *
 * A "run" is a maximal stretch of consecutive frames classified into the *same*
 * distress category above a low floor. The gate tracks the run's start time and
 * peak confidence; when a frame breaks the run (different category, a gap, or a
 * below-floor confidence) the run resets. On each frame it reports the current
 * run's sustained duration + peak confidence alongside the supplied
 * motionlessness so the caller can decide whether to emit.
 */
export class AcousticDistressGate {
  private runCategory: DistressCategory | null = null;
  private runStartedAt = 0;
  private runPeakConfidence = 0;
  private lastFrameAt = 0;

  /**
   * Low confidence floor below which a frame does not extend/keep a run. This
   * is intentionally well under the worker threshold; it only avoids letting
   * noise keep a run alive. The worker's `> 0.82` remains authoritative.
   */
  constructor(
    private readonly runFloor = 0.4,
    /** Max gap (ms) between frames before a run is considered broken. */
    private readonly maxFrameGapMs = 1000,
  ) {}

  /**
   * Fold one classified frame into the run state and return the current
   * distilled {@link AcousticSignal} (category + peak confidence + sustained
   * seconds + supplied motionlessness). Returns `null` when there is no active
   * run (e.g. the frame was below the floor and no run was in progress).
   */
  observe(
    frame: FrameClassification | null,
    now: number,
    motion: MotionState,
  ): AcousticSignal | null {
    const gap = now - this.lastFrameAt;
    this.lastFrameAt = now;

    const extendsRun =
      frame !== null &&
      frame.confidence >= this.runFloor &&
      this.runCategory === frame.category &&
      gap <= this.maxFrameGapMs;

    const startsRun =
      frame !== null &&
      frame.confidence >= this.runFloor &&
      (this.runCategory !== frame.category || gap > this.maxFrameGapMs);

    if (extendsRun) {
      this.runPeakConfidence = Math.max(this.runPeakConfidence, frame.confidence);
    } else if (startsRun) {
      this.runCategory = frame.category;
      this.runStartedAt = now;
      this.runPeakConfidence = frame.confidence;
    } else {
      // No qualifying frame: break any active run.
      this.reset();
      return null;
    }

    const sustainedSec = Math.max(0, (now - this.runStartedAt) / 1000);
    return {
      category: this.runCategory!,
      confidence: this.runPeakConfidence,
      sustainedSec,
      motionlessSec: motion.motionlessSec,
    };
  }

  /** Reset the run state (called on a broken run or after emitting upstream). */
  reset(): void {
    this.runCategory = null;
    this.runStartedAt = 0;
    this.runPeakConfidence = 0;
  }
}

/**
 * On-device pre-filter mirroring the worker's gate (R10.3, R10.4): would this
 * distilled signal be accepted? Returns `true` **iff** `confidence > 0.82` AND
 * `sustainedSec > 1.5` AND `motionlessSec >= 30`. Non-finite inputs never
 * qualify. The worker re-checks this authoritatively; the pre-filter only
 * avoids sending a doomed signal.
 */
export function meetsAcousticThreshold(signal: AcousticSignal): boolean {
  return (
    signal.confidence > ACOUSTIC_CONFIDENCE_THRESHOLD &&
    signal.sustainedSec > ACOUSTIC_SUSTAINED_THRESHOLD_SEC &&
    signal.motionlessSec >= ACOUSTIC_MOTIONLESS_THRESHOLD_SEC
  );
}

/**
 * Seam that forwards a qualifying distilled signal to the Sentinel_Worker via
 * the API (never audio — R10.2, R19.4). Implemented in the Expo binding over
 * the API client; a spy in tests.
 */
export interface AcousticSignalSink {
  emit(signal: AcousticSignal): Promise<void>;
}

/**
 * Convenience runner: observe a frame, and if the resulting distilled signal
 * meets the on-device pre-filter, forward it to the sink and reset the run
 * (so a single sustained event emits once, not every subsequent frame). Returns
 * the signal that was emitted, or `null` if nothing qualified. No audio is ever
 * held beyond the classifier call.
 */
export async function processAcousticFrame(
  gate: AcousticDistressGate,
  sink: AcousticSignalSink,
  frame: FrameClassification | null,
  now: number,
  motion: MotionState,
): Promise<AcousticSignal | null> {
  const signal = gate.observe(frame, now, motion);
  if (signal && meetsAcousticThreshold(signal)) {
    await sink.emit(signal);
    gate.reset();
    return signal;
  }
  return null;
}
