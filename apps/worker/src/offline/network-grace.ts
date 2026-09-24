/**
 * Offline network-grace guard (task 17.1, R24.3/R24.4).
 *
 * R24.4: *WHERE an Anchor device has been offline within the configured
 * network-grace window, THE Sentinel_Worker SHALL withhold escalation
 * attributable solely to missing heartbeats until buffered telemetry is
 * reconciled.*
 *
 * A network outage must never itself trigger a false escalation. The insight is
 * that "the device went silent" is only a *signal* when we are confident the
 * device could have reached us. If the device was recently offline (within the
 * grace window) and its buffered telemetry has not yet been reconciled via
 * bulk-sync (R24.2), a **heartbeat-silence-only** escalation is withheld — the
 * missing heartbeats may simply be sitting in the on-device
 * Offline_Telemetry_Queue.
 *
 * Crucially the guard is *narrow*: it withholds ONLY when heartbeat silence is
 * the sole trigger. Any non-silence trigger — a rhythm miss corroborated by
 * other signals, an acoustic-distress classification, or a Shadow_SOS — is a
 * real safety signal that offline buffering cannot explain away, so it is NEVER
 * withheld.
 *
 * Everything here is pure. {@link isHeartbeatSilenceOnly} and
 * {@link isWithinNetworkGrace} are the two predicates; {@link evaluateNetworkGrace}
 * combines them into a withhold decision; {@link createNetworkGraceGuard} wraps
 * that in the injectable `NetworkGraceGuard` seam the escalation open-path
 * consults before opening a heartbeat-silence incident.
 */

import type { AggregatePersonaEvaluation } from "../personas/evaluators.js";

/**
 * Default network-grace window (ms): how recently the device must have been
 * offline for heartbeat silence to be treated as possibly-buffered rather than
 * a real signal. 15 minutes is a conservative default aligned with the
 * escarpment between one and two missed 20-minute stage intervals; production
 * wiring can override it per-policy.
 */
export const DEFAULT_NETWORK_GRACE_WINDOW_MS = 15 * 60 * 1000;

/**
 * The set of escalation triggers we recognize for the offline-grace decision.
 * `heartbeat_silence` is the only trigger offline buffering can explain; every
 * other trigger is a corroborated real signal.
 */
export type EscalationTrigger =
  /** The rhythm miss / grace-deadline was the trigger with no other signal. */
  | "heartbeat_silence"
  /** A rhythm miss corroborated by other passive signals. */
  | "rhythm_with_other_signals"
  /** On-device acoustic-distress classification. */
  | "acoustic_distress"
  /** Silent hardware Shadow_SOS. */
  | "shadow_sos"
  /** Any other explicit real-world trigger. */
  | "other";

/**
 * The trigger context for one prospective escalation. `triggers` is the set of
 * distinct signals that would open the incident; heartbeat silence is
 * "silence-only" iff it is the *sole* member.
 */
export interface EscalationTriggerContext {
  triggers: readonly EscalationTrigger[];
}

/**
 * True iff the escalation's ONLY trigger is heartbeat silence.
 *
 * An empty trigger set is treated as heartbeat-silence-only: a grace-deadline
 * miss with no corroborating signal is exactly the silence case R24.4 guards.
 * Any non-silence trigger present makes this `false`.
 */
export function isHeartbeatSilenceOnly(
  ctx: EscalationTriggerContext,
): boolean {
  const nonSilence = ctx.triggers.filter((t) => t !== "heartbeat_silence");
  return nonSilence.length === 0;
}

/** Device connectivity/reconciliation state at evaluation time (R24.2/R24.3). */
export interface OfflineState {
  /**
   * Epoch-ms of the last successful telemetry synchronization (R24.3), or
   * `null`/`undefined` when the device has never synced. When the device was
   * last heard from recently we are *inside* the grace window.
   */
  lastTelemetrySyncAt?: number | null;
  /**
   * Whether buffered telemetry from an offline stretch is still awaiting
   * reconciliation (a bulk-sync flush that has not yet been applied, R24.2).
   * While `true`, missing heartbeats may simply be queued on-device.
   */
  pendingOfflineReconciliation?: boolean;
}

/**
 * True iff the device is *within* the network-grace window — i.e. heartbeat
 * silence could be explained by an unreconciled offline stretch.
 *
 * Two independent conditions put the device in-grace:
 *   1. an explicit `pendingOfflineReconciliation` flag (buffered telemetry not
 *      yet flushed, R24.2); OR
 *   2. `lastTelemetrySyncAt` is within `windowMs` of `now` (recently offline,
 *      so buffered heartbeats may still be en route, R24.3/R24.4).
 *
 * A device that has never synced (`lastTelemetrySyncAt` absent) and has no
 * pending reconciliation is NOT in grace: there is no recent connectivity to
 * attribute the silence to.
 */
export function isWithinNetworkGrace(
  state: OfflineState,
  now: number,
  windowMs: number = DEFAULT_NETWORK_GRACE_WINDOW_MS,
): boolean {
  if (state.pendingOfflineReconciliation === true) return true;
  const last = state.lastTelemetrySyncAt;
  if (typeof last !== "number") return false;
  // Elapsed silence since last sync; within the window ⇒ in grace. A future-
  // dated `last` (clock skew) yields a negative elapsed and is treated as
  // in-grace (very recent), which is the safe side for withholding.
  const elapsed = now - last;
  return elapsed <= windowMs;
}

/** The decision returned by {@link evaluateNetworkGrace}. */
export interface NetworkGraceDecision {
  /** Whether the escalation must be withheld (R24.4). */
  withhold: boolean;
  /** Reason, for logging / audit. */
  reason:
    | "withheld-heartbeat-silence-within-grace"
    | "admitted-non-silence-trigger"
    | "admitted-outside-grace"
    | "admitted-reconciled";
}

/**
 * Decide whether to withhold a prospective escalation under R24.4.
 *
 * Withhold **iff** the escalation is heartbeat-silence-only AND the device is
 * within the network-grace window (recently offline / pending reconciliation).
 * In every other case admit:
 *   - a non-silence trigger is a real signal (`admitted-non-silence-trigger`);
 *   - outside the grace window silence is genuine (`admitted-outside-grace` /
 *     `admitted-reconciled` once buffered telemetry has reconciled).
 */
export function evaluateNetworkGrace(input: {
  trigger: EscalationTriggerContext;
  offline: OfflineState;
  now: number;
  windowMs?: number;
}): NetworkGraceDecision {
  const windowMs = input.windowMs ?? DEFAULT_NETWORK_GRACE_WINDOW_MS;

  if (!isHeartbeatSilenceOnly(input.trigger)) {
    return { withhold: false, reason: "admitted-non-silence-trigger" };
  }
  if (!isWithinNetworkGrace(input.offline, input.now, windowMs)) {
    // Outside the window: if reconciliation is not pending, the silence is
    // genuine (buffered telemetry, if any, has already reconciled).
    return {
      withhold: false,
      reason: input.offline.pendingOfflineReconciliation
        ? "admitted-outside-grace"
        : "admitted-reconciled",
    };
  }
  return {
    withhold: true,
    reason: "withheld-heartbeat-silence-within-grace",
  };
}

/**
 * Injectable guard the escalation open-path consults before opening a
 * heartbeat-silence incident. Returns `true` to withhold (do NOT open the
 * incident), `false` to admit.
 */
export type NetworkGraceGuard = (input: {
  trigger: EscalationTriggerContext;
  offline: OfflineState;
  now: number;
}) => boolean;

/**
 * Build a {@link NetworkGraceGuard} over a fixed grace window. The default guard
 * simply calls {@link evaluateNetworkGrace}; a `null`/no-op guard (never
 * withholds) is appropriate wherever offline state is unavailable.
 */
export function createNetworkGraceGuard(
  windowMs: number = DEFAULT_NETWORK_GRACE_WINDOW_MS,
): NetworkGraceGuard {
  return ({ trigger, offline, now }) =>
    evaluateNetworkGrace({ trigger, offline, now, windowMs }).withhold;
}

/**
 * Derive the {@link EscalationTriggerContext} from a persona evaluation.
 *
 * Only the Elderly_Care rhythm miss maps to `heartbeat_silence` (the adaptive
 * wake-rhythm is inferred from passive heartbeats). Every other triggered
 * persona mode (Solo_Living inactivity, Active_Session immobility, Journey_Watch
 * transit deadline, Post_Op_Recovery daytime inactivity) is corroborated by a
 * non-heartbeat signal, so it maps to `rhythm_with_other_signals` and is never
 * withheld. This lets the rhythm-eval open-path feed its evaluation straight
 * into the grace guard.
 */
export function triggerContextFromEvaluation(
  evaluation: AggregatePersonaEvaluation,
): EscalationTriggerContext {
  const triggers: EscalationTrigger[] = evaluation.triggeredModes.map((mode) =>
    mode === "ELDERLY_CARE"
      ? "heartbeat_silence"
      : "rhythm_with_other_signals",
  );
  return { triggers };
}
