/**
 * Vitality_Pulse emission (R7.1, R7.2, R7.5; task 14.1).
 *
 * On a confirmed morning Routine_Rhythm the platform generates a warm
 * Vitality_Pulse for EACH Observer in the Circle (R7.1) and records the event
 * in the Vitality_Pulse_Log (R7.5). This module holds the PURE pulse-building
 * logic plus the {@link emitVitalityPulse} orchestration; every side effect —
 * loading Observers/Anchor, recording the log, delivering the push — lives
 * behind an injectable seam ({@link VitalityPulseDeps}) so the processor wiring
 * and unit tests stay hermetic. Push transport itself is NOT implemented here;
 * `deliverPulse` is a seam a later mobile/push task fulfills.
 *
 * CRITICAL INVARIANT (R22.6): this module has no path to open a Safety_Incident
 * or escalate. It never imports the escalation queue or an `openIncident` seam.
 * A Vitality_Pulse is a reassurance event only.
 *
 * Each pulse carries (R7.2):
 *   - the Anchor preferred display name,
 *   - the verified confirmation time rendered in the ANCHOR timezone,
 *   - available context such as step count and local weather.
 */

/** The step/weather context available at confirmation time (R7.2). */
export interface VitalityContext {
  /** Step count / delta available at confirmation, when known. */
  steps?: number;
  /** Local weather summary (e.g. "28°C, clear"), when known. */
  weather?: string;
}

/** Minimal Anchor identity needed to build a pulse (R7.2). */
export interface AnchorProfile {
  anchorId: string;
  /** Anchor preferred display name (R7.2); falls back to "Anchor" if unset. */
  preferredName: string | null;
  /** IANA timezone the confirmation time is rendered in (R7.2). */
  timezone: string;
}

/** An Observer that receives the pulse (R7.1). */
export interface ObserverRecipient {
  observerId: string;
  /** Platform push tokens; delivery is a seam, tokens are passed through. */
  pushTokens: string[];
}

/**
 * One Vitality_Pulse addressed to a single Observer (R7.1/R7.2). This is the
 * unit fanned out to the delivery seam and is fully self-describing so a push
 * transport can render it without another DB read.
 */
export interface VitalityPulse {
  circleId: string;
  anchorId: string;
  observerId: string;
  /** Anchor preferred display name (never a Banned_Term — R7.3). */
  anchorPreferredName: string;
  /** Verified confirmation time rendered in the Anchor timezone (R7.2). */
  confirmationTimeLocal: string;
  /** The Anchor timezone the time was rendered in (echoed for clients). */
  timezone: string;
  /** Epoch-millis of the confirmation, for clients that prefer raw instants. */
  confirmedAtMillis: number;
  /** Step/weather context (R7.2). */
  context: VitalityContext;
}

/** Injectable side-effect seams for Vitality_Pulse emission; all overridable. */
export interface VitalityPulseDeps {
  /**
   * Load the Anchor's profile (preferred name + timezone) for the pulse text.
   * Production wiring reads the `User` row; tests inject a fake.
   */
  loadAnchorProfile: (anchorId: string) => Promise<AnchorProfile>;
  /**
   * List the Observers of the Circle to fan the pulse out to (R7.1).
   * Production wiring reads `CircleMember` (role OBSERVER/MUTUAL); tests inject.
   */
  listObservers: (circleId: string) => Promise<ObserverRecipient[]>;
  /**
   * Record the Vitality_Pulse event in the Vitality_Pulse_Log (R7.5).
   * Production wiring inserts a `VitalityPulseLog` row; tests spy. One log row
   * captures the confirmed morning (circle + anchor + confirmedAt + context).
   */
  recordPulseLog: (input: {
    circleId: string;
    anchorId: string;
    confirmedAtMillis: number;
    context: VitalityContext;
  }) => Promise<void>;
  /**
   * Deliver a built pulse to one Observer. Modeled as a seam: push transport is
   * NOT implemented in the worker (a later mobile/push task fulfills it). The
   * default wiring only logs.
   */
  deliverPulse: (pulse: VitalityPulse) => Promise<void>;
}

/** Render an epoch-millis confirmation instant in the Anchor timezone (R7.2). */
export function renderConfirmationTime(
  atMillis: number,
  timezone: string,
): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(new Date(atMillis));
}

/**
 * Build the single Vitality_Pulse addressed to one Observer (pure). Carries the
 * Anchor preferred display name, the confirmation time in the Anchor timezone,
 * and the step/weather context (R7.2). Never references escalation (R22.6).
 */
export function buildPulseForObserver(input: {
  circleId: string;
  anchor: AnchorProfile;
  observer: ObserverRecipient;
  confirmedAtMillis: number;
  context: VitalityContext;
}): VitalityPulse {
  const anchorPreferredName =
    input.anchor.preferredName && input.anchor.preferredName.trim().length > 0
      ? input.anchor.preferredName
      : "Anchor";
  return {
    circleId: input.circleId,
    anchorId: input.anchor.anchorId,
    observerId: input.observer.observerId,
    anchorPreferredName,
    confirmationTimeLocal: renderConfirmationTime(
      input.confirmedAtMillis,
      input.anchor.timezone,
    ),
    timezone: input.anchor.timezone,
    confirmedAtMillis: input.confirmedAtMillis,
    context: input.context,
  };
}

/** Inputs to emit Vitality_Pulses for a confirmed morning routine (R7). */
export interface EmitVitalityPulseInput {
  circleId: string;
  anchorId: string;
  /** Epoch-millis of the verified confirmation. */
  confirmedAtMillis: number;
  /** Step/weather context available at confirmation (R7.2). */
  context?: VitalityContext;
}

/** Outcome of {@link emitVitalityPulse}. */
export interface EmitVitalityPulseResult {
  /** The pulses built + delivered, one per Observer (R7.1). */
  pulses: VitalityPulse[];
  /** True iff a Vitality_Pulse_Log row was recorded (R7.5). */
  logged: boolean;
}

/**
 * Emit a Vitality_Pulse per Observer for a confirmed morning Routine_Rhythm
 * (R7.1, R7.2, R7.5).
 *
 * Order of operations:
 *   1. load the Anchor profile (preferred name + timezone),
 *   2. list the Circle's Observers,
 *   3. build one pulse per Observer (Anchor name + tz-rendered confirmation
 *      time + context),
 *   4. record ONE Vitality_Pulse_Log row for the confirmed morning (R7.5),
 *   5. deliver each pulse via the push seam (transport not implemented here).
 *
 * NEVER opens an incident (R22.6) — there is no escalation seam in `deps`.
 */
export async function emitVitalityPulse(
  deps: VitalityPulseDeps,
  input: EmitVitalityPulseInput,
): Promise<EmitVitalityPulseResult> {
  const context: VitalityContext = input.context ?? {};
  const anchor = await deps.loadAnchorProfile(input.anchorId);
  const observers = await deps.listObservers(input.circleId);

  const pulses = observers.map((observer) =>
    buildPulseForObserver({
      circleId: input.circleId,
      anchor,
      observer,
      confirmedAtMillis: input.confirmedAtMillis,
      context,
    }),
  );

  // Record the confirmed-morning event once (R7.5), independent of Observer count.
  await deps.recordPulseLog({
    circleId: input.circleId,
    anchorId: input.anchorId,
    confirmedAtMillis: input.confirmedAtMillis,
    context,
  });

  // Fan out delivery (push transport is a seam; not implemented in the worker).
  for (const pulse of pulses) {
    await deps.deliverPulse(pulse);
  }

  return { pulses, logged: true };
}
