/**
 * Bedtime Battery Guardian — worker-side backstop (R32.1, R32.2, R32.3, R32.4).
 *
 * An evening evaluator runs on the Anchor device with this worker-side backstop
 * (design "Bedtime Battery Guardian (R32)"). Given a `(phase, batteryLevel,
 * chargerState)` reading the guardian decides one of three mutually exclusive
 * outcomes:
 *
 *   evaluateBatteryGuardian({ phase, batteryLevel, chargerState }):
 *     if phase == BEDTIME_MINUS_60 and battery < 25 and UNPLUGGED:
 *        -> emit gentle bedtime chime            + log BEDTIME_LOW              (R32.2)
 *     if phase == POST_MIDNIGHT   and battery < 15 and UNPLUGGED:
 *        -> log PRE_DAWN_BATTERY_EXHAUSTION_WARNING + notify Observer dashboard (R32.3)
 *     otherwise: no action.
 *
 * The decision is **pure**: {@link evaluateBatteryGuardian} is a deterministic
 * function of its input with no clock reads, no I/O, and no mutation. All
 * effects (chime emit, `BatteryWarningLog` write, Observer notify, and the
 * morning STAGE_1 incident flag) sit behind injectable seams so the running
 * logic ({@link runBatteryGuardian}, {@link flagMorningIncidentIfBatteryDepleted})
 * stays hermetic and unit-testable.
 *
 * The morning flag is presentational: a STAGE_1 incident whose failure is
 * solely attributable to a documented pre-dawn exhaustion is flagged "Likely
 * Battery Depletion" rather than an unverified-routine anomaly (R32.4). It does
 * NOT alter stage ordering — see design "The flag is presentational".
 */

/** Threshold below which the bedtime chime fires at BEDTIME_MINUS_60 (R32.2). */
export const BEDTIME_LOW_THRESHOLD = 25;

/** Threshold below which the pre-dawn exhaustion warning is logged (R32.3). */
export const PRE_DAWN_EXHAUSTION_THRESHOLD = 15;

/** Presentational label appended to a battery-depletion STAGE_1 incident (R32.4). */
export const LIKELY_BATTERY_DEPLETION_LABEL = "Likely Battery Depletion";

/**
 * Guardian evaluation phases. `BEDTIME_MINUS_60` is 60 minutes before the
 * Anchor's configured bed time (R32.1); `POST_MIDNIGHT` is the pre-dawn draining
 * window (R32.3). Other phases are accepted but always resolve to no action.
 */
export type GuardianPhase = "BEDTIME_MINUS_60" | "POST_MIDNIGHT" | (string & {});

/** Device charger state as persisted on `BatteryWarningLog.chargerState`. */
export type ChargerState = "PLUGGED" | "UNPLUGGED";

/** The kind persisted on `BatteryWarningLog.kind` (Prisma `BatteryWarningKind`). */
export type BatteryWarningKind = "BEDTIME_LOW" | "PRE_DAWN_BATTERY_EXHAUSTION_WARNING";

/** A single battery reading fed to the guardian. */
export interface BatteryReading {
  /** Evaluation phase for this tick. */
  phase: GuardianPhase;
  /** Device battery level as a percentage in [0, 100]. */
  batteryLevel: number;
  /** Whether the device is on a charger. */
  chargerState: ChargerState;
}

/**
 * The decision produced by {@link evaluateBatteryGuardian}. Exactly one of the
 * three shapes:
 *
 *   - `bedtime_chime`  — emit chime + log BEDTIME_LOW               (R32.2)
 *   - `pre_dawn_warning` — log PRE_DAWN_... + notify Observer        (R32.3)
 *   - `none`           — no action (plugged, above threshold, or wrong phase)
 */
export type GuardianDecision =
  | {
      action: "bedtime_chime";
      /** The chime prompts the Anchor to connect a charger (R32.2). */
      chime: true;
      logKind: "BEDTIME_LOW";
      notifyObserver: false;
    }
  | {
      action: "pre_dawn_warning";
      chime: false;
      logKind: "PRE_DAWN_BATTERY_EXHAUSTION_WARNING";
      /** The pre-dawn warning notifies the Observer dashboard (R32.3). */
      notifyObserver: true;
    }
  | {
      action: "none";
      chime: false;
      logKind: null;
      notifyObserver: false;
    };

/** Human-facing copy for the bedtime chime (design R32.2). */
export const BEDTIME_CHIME_MESSAGE =
  "connect charger to keep the morning shield active";

const NO_ACTION: GuardianDecision = {
  action: "none",
  chime: false,
  logKind: null,
  notifyObserver: false,
};

/**
 * Pure decision function (R32.1–R32.3). Deterministic over `(phase,
 * batteryLevel, chargerState)`; performs no I/O and no mutation.
 *
 * Emits a gentle bedtime chime **iff** `phase = BEDTIME_MINUS_60` AND
 * `batteryLevel < 25` AND `chargerState = UNPLUGGED` (R32.2); logs a pre-dawn
 * exhaustion warning + notifies the Observer dashboard **iff** `phase =
 * POST_MIDNIGHT` AND `batteryLevel < 15` AND `chargerState = UNPLUGGED` (R32.3).
 * Every other tuple — plugged in, at/above the threshold, or in any other phase
 * — resolves to `none`. Thresholds are strict (`< 25`, `< 15`): exactly 25% or
 * 15% does NOT trip the action.
 */
export function evaluateBatteryGuardian(reading: BatteryReading): GuardianDecision {
  const { phase, batteryLevel, chargerState } = reading;
  const unplugged = chargerState === "UNPLUGGED";

  if (
    phase === "BEDTIME_MINUS_60" &&
    unplugged &&
    batteryLevel < BEDTIME_LOW_THRESHOLD
  ) {
    return {
      action: "bedtime_chime",
      chime: true,
      logKind: "BEDTIME_LOW",
      notifyObserver: false,
    };
  }

  if (
    phase === "POST_MIDNIGHT" &&
    unplugged &&
    batteryLevel < PRE_DAWN_EXHAUSTION_THRESHOLD
  ) {
    return {
      action: "pre_dawn_warning",
      chime: false,
      logKind: "PRE_DAWN_BATTERY_EXHAUSTION_WARNING",
      notifyObserver: true,
    };
  }

  return NO_ACTION;
}

/**
 * Injectable effect seams for the guardian. Tests pass spies; production wiring
 * passes DB/queue-backed closures. Kept narrow so the guardian stays decoupled
 * from Prisma and the notification transport.
 */
export interface BatteryGuardianDeps {
  /** Emit the gentle bedtime chime to the Anchor device (R32.2). */
  emitChime: (input: {
    userId: string;
    message: string;
  }) => Promise<void> | void;
  /**
   * Persist a `BatteryWarningLog` row (Prisma `batteryWarningLog.create`).
   * `loggedAt` defaults on the DB side but may be supplied for determinism.
   */
  writeWarningLog: (input: {
    userId: string;
    kind: BatteryWarningKind;
    batteryLevel: number;
    chargerState: ChargerState;
    loggedAt?: Date | number;
  }) => Promise<void> | void;
  /** Notify the Observer dashboard of a pre-dawn exhaustion warning (R32.3). */
  notifyObserverDashboard: (input: {
    userId: string;
    batteryLevel: number;
  }) => Promise<void> | void;
}

/** The effect-bearing outcome of a single {@link runBatteryGuardian} tick. */
export interface GuardianRunResult {
  decision: GuardianDecision;
  /** Whether the chime seam was invoked. */
  chimed: boolean;
  /** Whether a `BatteryWarningLog` write was invoked. */
  logged: boolean;
  /** Whether the Observer dashboard was notified. */
  notified: boolean;
}

/**
 * Run one guardian tick for an Anchor: evaluate purely, then fire only the
 * seams the decision calls for. No action ⇒ no seam is touched at all, so a
 * plugged-in or healthy device incurs zero side-effects.
 *
 *   - bedtime_chime    → emitChime + writeWarningLog(BEDTIME_LOW)              (R32.2)
 *   - pre_dawn_warning → writeWarningLog(PRE_DAWN_...) + notifyObserverDashboard (R32.3)
 */
export async function runBatteryGuardian(
  deps: BatteryGuardianDeps,
  input: {
    userId: string;
    reading: BatteryReading;
    /** Optional deterministic timestamp forwarded to the log write. */
    loggedAt?: Date | number;
  },
): Promise<GuardianRunResult> {
  const decision = evaluateBatteryGuardian(input.reading);

  if (decision.action === "none") {
    return { decision, chimed: false, logged: false, notified: false };
  }

  const { batteryLevel, chargerState } = input.reading;
  let chimed = false;
  let logged = false;
  let notified = false;

  if (decision.action === "bedtime_chime") {
    await deps.emitChime({ userId: input.userId, message: BEDTIME_CHIME_MESSAGE });
    chimed = true;
  }

  // Both actionable decisions carry a log kind.
  await deps.writeWarningLog({
    userId: input.userId,
    kind: decision.logKind,
    batteryLevel,
    chargerState,
    ...(input.loggedAt !== undefined ? { loggedAt: input.loggedAt } : {}),
  });
  logged = true;

  if (decision.notifyObserver) {
    await deps.notifyObserverDashboard({ userId: input.userId, batteryLevel });
    notified = true;
  }

  return { decision, chimed, logged, notified };
}

/**
 * Minimal shape of a documented pre-dawn warning the morning-flag helper needs
 * (narrower than the Prisma `BatteryWarningLog` row). Only the `kind` and
 * `loggedAt` matter for attribution.
 */
export interface DocumentedWarning {
  kind: BatteryWarningKind;
  loggedAt: Date | number;
}

/** Coerce a `Date | number` into epoch-millis. */
function toMillis(value: Date | number): number {
  return typeof value === "number" ? value : value.getTime();
}

/**
 * The pre-dawn window used for morning-incident attribution: the span of the
 * night that could plausibly document a battery exhaustion for the failing
 * morning check. Callers pass the concrete window; the helper only tests
 * membership.
 */
export interface PreDawnWindow {
  /** Inclusive start of the pre-dawn window (epoch-millis or Date). */
  start: Date | number;
  /** Exclusive end of the pre-dawn window (epoch-millis or Date). */
  end: Date | number;
}

/**
 * Pure predicate (R32.4): does a documented `PRE_DAWN_BATTERY_EXHAUSTION_WARNING`
 * exist for the user within the pre-dawn window? Returns `true` iff at least one
 * warning of that kind was logged in `[window.start, window.end)`. `BEDTIME_LOW`
 * warnings do NOT qualify — only the pre-dawn exhaustion kind attributes a
 * morning failure to battery depletion.
 */
export function hasDocumentedPreDawnWarning(
  warnings: readonly DocumentedWarning[],
  window: PreDawnWindow,
): boolean {
  const start = toMillis(window.start);
  const end = toMillis(window.end);
  for (const w of warnings) {
    if (w.kind !== "PRE_DAWN_BATTERY_EXHAUSTION_WARNING") continue;
    const at = toMillis(w.loggedAt);
    if (at >= start && at < end) return true;
  }
  return false;
}

/** Injectable seam that flags a STAGE_1 incident as likely battery depletion. */
export interface MorningIncidentFlagDeps {
  /**
   * Fetch the Anchor's documented battery warnings that fall in the pre-dawn
   * window. Production wiring performs the Prisma `batteryWarningLog.findMany`;
   * tests pass a pure array.
   */
  fetchWarnings: (
    userId: string,
    window: PreDawnWindow,
  ) => Promise<readonly DocumentedWarning[]> | readonly DocumentedWarning[];
  /**
   * Mark the STAGE_1 incident as "Likely Battery Depletion": set
   * `batteryDepletionLikely = true` and append the label to the audit trail
   * (R32.4). Production wiring performs the Prisma update; tests observe it.
   */
  flagIncident: (input: {
    incidentId: string;
    label: string;
  }) => Promise<void> | void;
}

/** Outcome of a morning-flag attempt. */
export interface MorningFlagResult {
  /** Whether a documented pre-dawn warning attributed the failure to battery. */
  flagged: boolean;
}

/**
 * Flag a morning STAGE_1 incident as "Likely Battery Depletion" **iff** a
 * documented `PRE_DAWN_BATTERY_EXHAUSTION_WARNING` exists for the Anchor within
 * the pre-dawn window (R32.4). When none exists the incident is left untouched
 * (an unverified-routine anomaly) and the flag seam is never invoked.
 *
 * The flag is presentational and does not alter stage ordering (design).
 */
export async function flagMorningIncidentIfBatteryDepleted(
  deps: MorningIncidentFlagDeps,
  input: {
    userId: string;
    incidentId: string;
    window: PreDawnWindow;
  },
): Promise<MorningFlagResult> {
  const warnings = await deps.fetchWarnings(input.userId, input.window);
  if (!hasDocumentedPreDawnWarning(warnings, input.window)) {
    return { flagged: false };
  }
  await deps.flagIncident({
    incidentId: input.incidentId,
    label: LIKELY_BATTERY_DEPLETION_LABEL,
  });
  return { flagged: true };
}
