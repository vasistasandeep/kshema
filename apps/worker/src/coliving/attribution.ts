/**
 * Co-living shared-signal attribution (R35.1, R35.2; task 16.3).
 *
 * A `HouseholdProfile` groups multiple Anchors sharing one domicile and local
 * network (R35.1). Two device classes are shared and therefore ambiguous about
 * *which* Anchor is awake:
 *
 *   - a media device whose id is in `sharedMediaDeviceIds`
 *     (Ghost_Signal `signalType = MEDIA_DEVICE_WAKE`), and
 *   - a Wi-Fi BSSID in `sharedWifiBssids`
 *     (Ghost_Signal `signalType = HOME_WIFI_REASSOCIATION`).
 *
 * A Ghost_Signal from either source is attributed as *"household activity
 * confirmed"* (R35.2): it proves *someone* in the home is up, but not *who*.
 *
 * The behavioral consequence is the whole point of this module: for a co-living
 * Anchor whose `Sentinel_Policy` **requires independent confirmation**, a
 * household signal alone does NOT confirm that Anchor's morning routine — an
 * *individual* phone telemetry event (a screen unlock or a positive step delta
 * from THAT Anchor's own device) is still required (design "Shared Ghost_Signal
 * attribution (R35.2)"). For an Anchor that does not require independent
 * confirmation, household activity is sufficient (the default single-occupant
 * behavior, R6.4/R6.5).
 *
 * Everything here is **pure**: deterministic predicates over their inputs with
 * no clock reads, no I/O, and no mutation. The `rhythm-eval` wiring folds the
 * result of {@link isRoutineConfirmedForCoLivingAnchor} into the existing
 * confirming-signal decision additively (task 16.3), leaving the
 * single-occupant path untouched.
 */

import type { ConfirmingSignal } from "../personas/confirming-signal.js";

/**
 * The minimal shape of a `HouseholdProfile` this module needs. Deliberately
 * narrower than the Prisma model (which also carries `id`, `createdAt`, the
 * relation) so the attribution logic stays decoupled from the DB row shape and
 * fully unit-testable.
 */
export interface HouseholdProfileView {
  /** Human household name (e.g. "Rao residence"). */
  householdName: string;
  /** Co-living Anchors sharing this domicile (R35.1). */
  anchorIds: readonly string[];
  /** BSSIDs treated as shared household activity. */
  sharedWifiBssids: readonly string[];
  /** Media-device ids treated as shared household activity. */
  sharedMediaDeviceIds: readonly string[];
}

/**
 * A Ghost_Signal as attribution sees it. Mirrors the `GhostSignalLog` columns
 * the classification depends on: the `signalType` and the `source` (the
 * device/BSSID identifier the signal originated from). Kept narrow so tests
 * pass a plain object and production wiring maps a Prisma row.
 */
export interface GhostSignalView {
  /** Which anchor's device *reported* the signal (may be either co-resident). */
  anchorId?: string;
  /** The Ghost_Signal class. */
  signalType: "MEDIA_DEVICE_WAKE" | "HOME_WIFI_REASSOCIATION";
  /**
   * The originating identifier: a media-device id for `MEDIA_DEVICE_WAKE`, or a
   * Wi-Fi BSSID for `HOME_WIFI_REASSOCIATION`. Matched against the household's
   * `sharedMediaDeviceIds` / `sharedWifiBssids`.
   */
  source: string;
}

/**
 * The attribution of a single Ghost_Signal.
 *
 * `HOUSEHOLD` ⇒ the signal came from a shared device/BSSID and is attributed as
 * "household activity confirmed" (R35.2): proof that *someone* is up, not who.
 * `INDIVIDUAL` ⇒ the signal is NOT from a shared source, so it is attributable
 * to the reporting Anchor as an individual signal (falls through to the normal
 * single-occupant confirmation path).
 */
export type GhostSignalAttribution = "HOUSEHOLD" | "INDIVIDUAL";

/**
 * Classify a Ghost_Signal against a household profile (R35.2).
 *
 * Returns `HOUSEHOLD` iff the signal originates from a source the household
 * marks as shared — a `MEDIA_DEVICE_WAKE` whose `source` is in
 * `sharedMediaDeviceIds`, or a `HOME_WIFI_REASSOCIATION` whose `source` is in
 * `sharedWifiBssids`. Otherwise `INDIVIDUAL`.
 *
 * Pure and total: an unknown/empty source that matches nothing is `INDIVIDUAL`.
 */
export function attributeGhostSignal(
  signal: GhostSignalView,
  profile: HouseholdProfileView,
): GhostSignalAttribution {
  if (signal.signalType === "MEDIA_DEVICE_WAKE") {
    return profile.sharedMediaDeviceIds.includes(signal.source)
      ? "HOUSEHOLD"
      : "INDIVIDUAL";
  }
  // HOME_WIFI_REASSOCIATION
  return profile.sharedWifiBssids.includes(signal.source)
    ? "HOUSEHOLD"
    : "INDIVIDUAL";
}

/**
 * True iff a Ghost_Signal is attributed as "household activity confirmed"
 * (R35.2) — i.e. it comes from a shared media device or shared Wi-Fi BSSID.
 * This is the R35.1/R35.2 attribution predicate the design describes.
 */
export function isHouseholdConfirmed(
  signal: GhostSignalView,
  profile: HouseholdProfileView,
): boolean {
  return attributeGhostSignal(signal, profile) === "HOUSEHOLD";
}

/**
 * True iff any of `signals` is an INDIVIDUAL confirming signal for the Anchor —
 * a screen unlock or a positive step delta observed from that Anchor's own
 * device (R35.2). Charger-unplug and generic Ghost_Signals are excluded here on
 * purpose: R35.2 names screen unlock / step delta as the individual telemetry
 * that resolves shared-signal ambiguity, so this predicate is deliberately
 * stricter than the general {@link ConfirmingSignal} set.
 *
 * `step_delta` confirms only when strictly positive (mirrors
 * `isConfirmingSignal`); a zero/negative delta is not evidence of activity.
 */
export function isIndividuallyConfirmed(
  signals: readonly ConfirmingSignal[],
): boolean {
  return signals.some((s) => {
    if (s.type === "screen_unlock") return true;
    if (s.type === "step_delta") return (s.stepDelta ?? 0) > 0;
    return false;
  });
}

/** Inputs to the co-living routine-confirmation combiner (R35.2). */
export interface CoLivingConfirmationInput {
  /**
   * Whether THIS Anchor's `Sentinel_Policy` requires independent confirmation
   * (design "for any co-living Anchor whose Sentinel_Policy requires it").
   */
  requiresIndependentConfirmation: boolean;
  /**
   * Whether a shared household Ghost_Signal (media device / Wi-Fi BSSID) has
   * been attributed as "household activity confirmed" for this window (R35.2).
   */
  householdConfirmed: boolean;
  /**
   * Whether an INDIVIDUAL confirming signal (screen unlock / positive step
   * delta) from THIS Anchor's own device has been observed (R35.2).
   */
  individuallyConfirmed: boolean;
}

/**
 * Combine household + individual attribution into the routine-confirmation
 * decision for one co-living Anchor (R35.2).
 *
 * Truth table (design "Shared Ghost_Signal attribution (R35.2)"):
 *
 *   requiresIndependent | household | individual | confirmed?
 *   --------------------|-----------|------------|-----------
 *   false               |   true    |    any     |   true   (household activity suffices)
 *   false               |   false   |    true    |   true   (individual signal suffices)
 *   false               |   false   |    false   |   false
 *   true                |   any     |    true    |   true   (individual required + present)
 *   true                |   true    |    false   |   FALSE  ← the R35.2 guard
 *   true                |   false   |    false   |   false
 *
 * i.e. `confirmed = individuallyConfirmed || (householdConfirmed &&
 * !requiresIndependentConfirmation)`. The single case R35.2 exists to prevent
 * is `requiresIndependent && householdConfirmed && !individuallyConfirmed`,
 * which yields `false` — a household signal alone must NOT confirm an Anchor
 * that requires independent confirmation.
 */
export function isRoutineConfirmedForCoLivingAnchor(
  input: CoLivingConfirmationInput,
): boolean {
  if (input.individuallyConfirmed) return true;
  if (input.requiresIndependentConfirmation) return false;
  return input.householdConfirmed;
}

/**
 * Convenience combiner that derives {@link CoLivingConfirmationInput} from raw
 * signals + the household profile, then applies
 * {@link isRoutineConfirmedForCoLivingAnchor} (R35.2).
 *
 * `ghostSignals` are the Ghost_Signals observed for the window; the routine is
 * household-confirmed iff any is attributed HOUSEHOLD. `confirmingSignals` are
 * the Anchor's own confirming signals; it is individually confirmed iff any is
 * a screen unlock / positive step delta ({@link isIndividuallyConfirmed}).
 */
export function evaluateCoLivingConfirmation(input: {
  requiresIndependentConfirmation: boolean;
  ghostSignals: readonly GhostSignalView[];
  confirmingSignals: readonly ConfirmingSignal[];
  profile: HouseholdProfileView;
}): boolean {
  const householdConfirmed = input.ghostSignals.some((g) =>
    isHouseholdConfirmed(g, input.profile),
  );
  const individuallyConfirmed = isIndividuallyConfirmed(input.confirmingSignals);
  return isRoutineConfirmedForCoLivingAnchor({
    requiresIndependentConfirmation: input.requiresIndependentConfirmation,
    householdConfirmed,
    individuallyConfirmed,
  });
}

/**
 * The co-living partner(s) of `anchorId` within a household: every other
 * `anchorIds` member. Pure helper used by the partner check-in step to address
 * the quiet STAGE_1 check-in (R35.3). Returns `[]` when the Anchor is the sole
 * resident or is not a member of the profile.
 */
export function coLivingPartnersOf(
  anchorId: string,
  profile: HouseholdProfileView,
): string[] {
  if (!profile.anchorIds.includes(anchorId)) return [];
  return profile.anchorIds.filter((id) => id !== anchorId);
}
