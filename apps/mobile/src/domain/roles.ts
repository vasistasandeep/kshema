/**
 * Role-based surface resolution (R2.6).
 *
 * Expo Router renders Anchor vs Observer surfaces from the active
 * `CircleMember.role`. A Mutual member is treated as both an Anchor and an
 * Observer within the Circle, so the app renders both surfaces (R2.6). This
 * module maps a role onto the set of surfaces to mount, and the onboarding
 * state onto the initial route.
 */
import type { CircleRole } from "@kshema/types";

/** The distinct product surfaces the router can mount. */
export type Surface = "anchor" | "observer";

/**
 * R2.6 — surfaces to render for a given Circle role. ANCHOR → anchor,
 * OBSERVER → observer, MUTUAL → both.
 */
export function surfacesForRole(role: CircleRole): Surface[] {
  switch (role) {
    case "ANCHOR":
      return ["anchor"];
    case "OBSERVER":
      return ["observer"];
    case "MUTUAL":
      return ["anchor", "observer"];
    default: {
      // Exhaustiveness guard: a new role must be handled explicitly.
      const never: never = role;
      throw new Error(`Unhandled CircleRole: ${String(never)}`);
    }
  }
}

/** Whether the Anchor surface should be mounted for this role. */
export function showsAnchorSurface(role: CircleRole): boolean {
  return surfacesForRole(role).includes("anchor");
}

/** Whether the Observer surface should be mounted for this role. */
export function showsObserverSurface(role: CircleRole): boolean {
  return surfacesForRole(role).includes("observer");
}

/** High-level onboarding/session state used to pick the initial route. */
export interface OnboardingState {
  /** A private key exists in the Secure_Enclave (identity established). */
  readonly hasIdentity: boolean;
  /** An authenticated API session exists. */
  readonly hasSession: boolean;
  /** A preferred display name has been provided (R1.7). */
  readonly hasPreferredName: boolean;
  /** The current Safety_Disclaimer version has been accepted (R26.2). */
  readonly disclaimerAccepted: boolean;
  /** The user belongs to at least one Circle. */
  readonly hasCircle: boolean;
}

/** Router destinations for the onboarding funnel. */
export type OnboardingRoute =
  | "/onboarding/welcome"
  | "/onboarding/verify"
  | "/onboarding/disclaimer"
  | "/onboarding/preferred-name"
  | "/onboarding/join-circle"
  | "/(app)";

/**
 * Resolve the next route from onboarding state. The order enforces the spec
 * gates: identity + session first, then the mandatory disclaimer (R26.2), then
 * the preferred-name prompt before joining a Circle (R1.7), then Circle
 * membership, then the main app.
 */
export function resolveOnboardingRoute(state: OnboardingState): OnboardingRoute {
  if (!state.hasIdentity || !state.hasSession) return "/onboarding/welcome";
  if (!state.disclaimerAccepted) return "/onboarding/disclaimer";
  if (!state.hasPreferredName) return "/onboarding/preferred-name";
  if (!state.hasCircle) return "/onboarding/join-circle";
  return "/(app)";
}
