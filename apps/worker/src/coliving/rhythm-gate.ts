/**
 * Co-living confirmation gate for the `rhythm-eval` grace-check path (R35.2;
 * task 16.3).
 *
 * The `rhythm-eval` grace-check decision folds the result of this gate into its
 * routine-confirmation flag additively (see `personas/rhythm-eval.ts`): when the
 * gate reports a co-living Anchor's routine confirmed, that outcome is OR'd into
 * the existing confirmation, so a shared household Ghost_Signal can confirm a
 * non-independent Anchor while an Anchor that requires independent confirmation
 * is only confirmed by its own screen-unlock / step-delta (the R35.2 guard).
 *
 * The gate encapsulates the household lookup + signal collection behind a single
 * injectable seam ({@link CoLivingContextLookup}) so the wiring stays hermetic:
 * tests pass a pure closure; production wiring queries `HouseholdProfile`,
 * `GhostSignalLog`, and the Anchor's confirming signals for the service day.
 * When the Anchor is not co-living the gate reports `false` (no override), so
 * the single-occupant path is unchanged.
 */

import type { ConfirmingSignal } from "../personas/confirming-signal.js";
import {
  evaluateCoLivingConfirmation,
  type GhostSignalView,
  type HouseholdProfileView,
} from "./attribution.js";

/**
 * The co-living context needed to decide confirmation for one Anchor on one
 * service day (R35.2). `null` ⇒ the Anchor is not part of a co-living
 * household, so there is no co-living override.
 */
export interface CoLivingContext {
  /** The Anchor's household profile. */
  profile: HouseholdProfileView;
  /** Whether THIS Anchor's Sentinel_Policy requires independent confirmation. */
  requiresIndependentConfirmation: boolean;
  /** Ghost_Signals observed for the window (any shared ⇒ household confirmed). */
  ghostSignals: readonly GhostSignalView[];
  /** THIS Anchor's own confirming signals (screen unlock / step delta count). */
  confirmingSignals: readonly ConfirmingSignal[];
}

/**
 * Injectable seam that gathers the {@link CoLivingContext} for an Anchor on a
 * service day. Production wiring queries `HouseholdProfile` for the Anchor,
 * `GhostSignalLog` for the window, the Anchor's confirming signals, and the
 * Anchor's `SentinelPolicy` for the independent-confirmation flag; tests pass a
 * pure closure. Returns `null` for a non-co-living Anchor.
 */
export type CoLivingContextLookup = (
  anchorId: string,
  serviceDay: string,
) => Promise<CoLivingContext | null> | (CoLivingContext | null);

/**
 * The gate the `rhythm-eval` grace-check path consults to decide whether a
 * co-living Anchor's morning routine is confirmed (R35.2).
 */
export interface CoLivingConfirmationGate {
  /**
   * `true` iff the co-living Anchor's routine is confirmed for the service day
   * under the R35.2 rules. `false` for a non-co-living Anchor (no override) and
   * for a co-living Anchor whose confirmation requirement is not met (e.g. an
   * independent-confirmation Anchor with only a shared household signal).
   */
  isRoutineConfirmed(
    anchorId: string,
    serviceDay: string,
  ): Promise<boolean>;
}

/**
 * Build a {@link CoLivingConfirmationGate} over an injectable context lookup.
 *
 * The gate is stateless: every consult re-fetches the Anchor's co-living
 * context and re-applies {@link evaluateCoLivingConfirmation} (R35.2). A `null`
 * context (non-co-living Anchor) resolves to `false` — no override.
 */
export function createCoLivingConfirmationGate(
  lookup: CoLivingContextLookup,
): CoLivingConfirmationGate {
  return {
    async isRoutineConfirmed(anchorId, serviceDay) {
      const ctx = await lookup(anchorId, serviceDay);
      if (!ctx) return false;
      return evaluateCoLivingConfirmation({
        requiresIndependentConfirmation: ctx.requiresIndependentConfirmation,
        ghostSignals: ctx.ghostSignals,
        confirmingSignals: ctx.confirmingSignals,
        profile: ctx.profile,
      });
    },
  };
}

/**
 * A no-op gate that never overrides confirmation. Safe default for wiring that
 * has no co-living context source yet, and an explicit "co-living disabled" seam
 * in tests.
 */
export function createNoopCoLivingConfirmationGate(): CoLivingConfirmationGate {
  return {
    async isRoutineConfirmed() {
      return false;
    },
  };
}
