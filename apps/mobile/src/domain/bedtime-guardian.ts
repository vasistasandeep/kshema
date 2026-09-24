/**
 * Bedtime Battery Guardian — on-device evaluator (R32.1, R32.2; task 22.3).
 *
 * 60 minutes before the Anchor's configured expected bed time the app reads the
 * device battery level and charging state (R32.1) and, if the battery is low and
 * the device is unplugged, emits a gentle audible bedtime chime prompting the
 * Anchor to connect the charger to keep the morning shield active (R32.2).
 *
 * This is the on-device counterpart to the worker-side backstop
 * (`apps/worker/src/battery/guardian.ts`, task 17.3). The two share the same
 * thresholds and phase vocabulary so behaviour is identical on both sides; the
 * device-side path exists so the chime fires locally even if the device is
 * offline. The post-midnight pre-dawn warning (R32.3) is the *worker's*
 * responsibility (it must notify the Observer dashboard), so this on-device
 * evaluator scopes to the R32.1/R32.2 bedtime chime — but it can still report a
 * `pre_dawn_warning` decision so a binding may surface a local hint.
 *
 * {@link evaluateBedtimeGuardian} is pure (no clock, no I/O); the platform
 * battery read and the chime playback live behind {@link BatteryReader} /
 * {@link ChimePlayer} seams.
 */

/** Threshold below which the bedtime chime fires at BEDTIME_MINUS_60 (R32.2). */
export const BEDTIME_LOW_THRESHOLD = 25;

/** Threshold below which the pre-dawn exhaustion decision is reached (R32.3). */
export const PRE_DAWN_EXHAUSTION_THRESHOLD = 15;

/** Human-facing copy for the bedtime chime (design R32.2). */
export const BEDTIME_CHIME_MESSAGE =
  "connect charger to keep the morning shield active";

/**
 * Evaluation phase. `BEDTIME_MINUS_60` is 60 minutes before the configured bed
 * time (R32.1); `POST_MIDNIGHT` is the pre-dawn draining window (R32.3). Any
 * other phase always resolves to no action. Matches the worker's `GuardianPhase`.
 */
export type BedtimePhase = "BEDTIME_MINUS_60" | "POST_MIDNIGHT" | (string & {});

/** Device charger state. */
export type ChargerState = "PLUGGED" | "UNPLUGGED";

/** A single battery reading fed to the evaluator. */
export interface BatteryReading {
  readonly phase: BedtimePhase;
  /** Battery level as a percentage in [0, 100]. */
  readonly batteryLevel: number;
  readonly chargerState: ChargerState;
}

/**
 * Decision produced by {@link evaluateBedtimeGuardian}. Mirrors the worker's
 * decision shape (minus the worker-only log/notify wiring):
 *   - `bedtime_chime`   — play the gentle chime (R32.2),
 *   - `pre_dawn_warning`— pre-dawn exhaustion detected on-device (R32.3 hint),
 *   - `none`            — plugged in, above threshold, or wrong phase.
 */
export type BedtimeDecision =
  | { action: "bedtime_chime"; chime: true }
  | { action: "pre_dawn_warning"; chime: false }
  | { action: "none"; chime: false };

const NO_ACTION: BedtimeDecision = { action: "none", chime: false };

/**
 * Pure decision function (R32.1, R32.2; R32.3 hint). Deterministic over
 * `(phase, batteryLevel, chargerState)`; no I/O, no mutation.
 *
 * Emits a bedtime chime **iff** `phase = BEDTIME_MINUS_60` AND
 * `batteryLevel < 25` AND `chargerState = UNPLUGGED` (R32.2). Reports a pre-dawn
 * warning **iff** `phase = POST_MIDNIGHT` AND `batteryLevel < 15` AND
 * `chargerState = UNPLUGGED` (R32.3). Every other tuple — plugged in, at/above
 * the threshold, or another phase — resolves to `none`. Thresholds are strict
 * (`< 25`, `< 15`): exactly 25% or 15% does NOT trip the action, matching the
 * worker.
 */
export function evaluateBedtimeGuardian(reading: BatteryReading): BedtimeDecision {
  const { phase, batteryLevel, chargerState } = reading;
  const unplugged = chargerState === "UNPLUGGED";

  if (
    phase === "BEDTIME_MINUS_60" &&
    unplugged &&
    batteryLevel < BEDTIME_LOW_THRESHOLD
  ) {
    return { action: "bedtime_chime", chime: true };
  }

  if (
    phase === "POST_MIDNIGHT" &&
    unplugged &&
    batteryLevel < PRE_DAWN_EXHAUSTION_THRESHOLD
  ) {
    return { action: "pre_dawn_warning", chime: false };
  }

  return NO_ACTION;
}

/**
 * Platform seam that reads current battery level + charger state (R32.1).
 * Implemented over `expo-battery`; a spy in tests. May reject/return null if
 * the read fails (permission revoked) — the runner then skips silently rather
 * than emitting a false chime (design "Bedtime battery evaluation (R32)").
 */
export interface BatteryReader {
  read(): Promise<{ batteryLevel: number; chargerState: ChargerState } | null>;
}

/** Platform seam that plays the gentle bedtime chime (R32.2). */
export interface ChimePlayer {
  play(message: string): Promise<void> | void;
}

/** Outcome of one on-device bedtime evaluation. */
export interface BedtimeRunResult {
  decision: BedtimeDecision;
  /** Whether the chime seam was invoked. */
  chimed: boolean;
  /** True when the battery read was unavailable and the tick was skipped. */
  skipped: boolean;
}

/**
 * Run one on-device bedtime evaluation for the given `phase`: read the battery
 * (R32.1), evaluate purely, and play the chime only when the decision calls for
 * it (R32.2). If the battery read is unavailable, skip silently (no chime, no
 * warning) — never emit a false chime on a failed read.
 */
export async function runBedtimeGuardian(
  deps: { reader: BatteryReader; chime: ChimePlayer },
  phase: BedtimePhase,
): Promise<BedtimeRunResult> {
  const reading = await deps.reader.read();
  if (reading === null) {
    return { decision: NO_ACTION, chimed: false, skipped: true };
  }

  const decision = evaluateBedtimeGuardian({
    phase,
    batteryLevel: reading.batteryLevel,
    chargerState: reading.chargerState,
  });

  if (decision.action === "bedtime_chime") {
    await deps.chime.play(BEDTIME_CHIME_MESSAGE);
    return { decision, chimed: true, skipped: false };
  }

  return { decision, chimed: false, skipped: false };
}
