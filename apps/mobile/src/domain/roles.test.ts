import { describe, expect, it } from "vitest";
import {
  resolveOnboardingRoute,
  showsAnchorSurface,
  showsObserverSurface,
  surfacesForRole,
  type OnboardingState,
} from "./roles.js";

describe("surfacesForRole (R2.6)", () => {
  it("maps ANCHOR → anchor only", () => {
    expect(surfacesForRole("ANCHOR")).toEqual(["anchor"]);
    expect(showsAnchorSurface("ANCHOR")).toBe(true);
    expect(showsObserverSurface("ANCHOR")).toBe(false);
  });

  it("maps OBSERVER → observer only", () => {
    expect(surfacesForRole("OBSERVER")).toEqual(["observer"]);
    expect(showsObserverSurface("OBSERVER")).toBe(true);
    expect(showsAnchorSurface("OBSERVER")).toBe(false);
  });

  it("maps MUTUAL → both surfaces (R2.6)", () => {
    expect(surfacesForRole("MUTUAL")).toEqual(["anchor", "observer"]);
    expect(showsAnchorSurface("MUTUAL")).toBe(true);
    expect(showsObserverSurface("MUTUAL")).toBe(true);
  });
});

describe("resolveOnboardingRoute funnel order (R26.2 before R1.7 before Circle)", () => {
  const complete: OnboardingState = {
    hasIdentity: true,
    hasSession: true,
    hasPreferredName: true,
    disclaimerAccepted: true,
    hasCircle: true,
  };

  it("routes to welcome without identity or session", () => {
    expect(
      resolveOnboardingRoute({ ...complete, hasIdentity: false }),
    ).toBe("/onboarding/welcome");
    expect(
      resolveOnboardingRoute({ ...complete, hasSession: false }),
    ).toBe("/onboarding/welcome");
  });

  it("routes to the disclaimer gate before anything else post-auth (R26.2)", () => {
    expect(
      resolveOnboardingRoute({
        ...complete,
        disclaimerAccepted: false,
        hasPreferredName: false,
        hasCircle: false,
      }),
    ).toBe("/onboarding/disclaimer");
  });

  it("routes to the preferred-name prompt before joining a Circle (R1.7)", () => {
    expect(
      resolveOnboardingRoute({
        ...complete,
        hasPreferredName: false,
        hasCircle: false,
      }),
    ).toBe("/onboarding/preferred-name");
  });

  it("routes to join-circle when everything else is done but no Circle", () => {
    expect(resolveOnboardingRoute({ ...complete, hasCircle: false })).toBe(
      "/onboarding/join-circle",
    );
  });

  it("routes into the app when fully onboarded", () => {
    expect(resolveOnboardingRoute(complete)).toBe("/(app)");
  });
});
