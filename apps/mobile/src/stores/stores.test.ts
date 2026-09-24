import { describe, expect, it } from "vitest";
import type { AuthSession } from "@kshema/types";
import { createTestStore } from "./slice.js";
import { createSessionSlice } from "./session-slice.js";
import { createMembershipSlice, type Membership } from "./membership-slice.js";
import { createPolicySlice, DEFAULT_PERSONA_MODE } from "./policy-slice.js";
import { createDashboardSlice } from "./dashboard-slice.js";
import { recordDisclaimerAcceptance } from "../domain/disclaimer.js";

const SESSION: AuthSession = {
  userId: "u1",
  accessToken: "a",
  refreshToken: "r",
  expiresAt: new Date().toISOString(),
};

function membership(role: Membership["member"]["role"], id = "c1"): Membership {
  return {
    circleId: id,
    circleName: "Family",
    member: {
      memberId: `m-${id}`,
      userId: "u1",
      role,
      canTriggerIVR: false,
      canAccessBlackBox: role !== "ANCHOR",
    },
  };
}

describe("session slice (R1, R26)", () => {
  it("tracks auth, identity, preferred name, and disclaimer gate", () => {
    const s = createTestStore(createSessionSlice);
    expect(s.getState().isAuthenticated()).toBe(false);
    expect(s.getState().needsPreferredName()).toBe(true);
    expect(s.getState().canActivateShield()).toBe(false);

    s.getState().setSession(SESSION);
    s.getState().markIdentityCreated();
    s.getState().setPreferredName("Amma");
    s.getState().acceptDisclaimer(recordDisclaimerAcceptance());

    expect(s.getState().isAuthenticated()).toBe(true);
    expect(s.getState().hasIdentity).toBe(true);
    expect(s.getState().needsPreferredName()).toBe(false);
    expect(s.getState().canActivateShield()).toBe(true);
  });

  it("signOut clears the session but keeps identity + disclaimer", () => {
    const s = createTestStore(createSessionSlice);
    s.getState().setSession(SESSION);
    s.getState().markIdentityCreated();
    s.getState().acceptDisclaimer(recordDisclaimerAcceptance());
    s.getState().signOut();
    expect(s.getState().isAuthenticated()).toBe(false);
    expect(s.getState().hasIdentity).toBe(true);
    expect(s.getState().canActivateShield()).toBe(true);
  });
});

describe("membership slice (R2, R2.6)", () => {
  it("derives active role and surfaces, defaulting the active circle", () => {
    const s = createTestStore(createMembershipSlice);
    expect(s.getState().hasCircle()).toBe(false);
    expect(s.getState().surfaces()).toEqual([]);

    s.getState().addMembership(membership("MUTUAL"));
    expect(s.getState().hasCircle()).toBe(true);
    expect(s.getState().activeRole()).toBe("MUTUAL");
    expect(s.getState().surfaces()).toEqual(["anchor", "observer"]);
  });

  it("keeps the active circle across setMemberships when still present", () => {
    const s = createTestStore(createMembershipSlice);
    s.getState().setMemberships([membership("OBSERVER", "c1"), membership("ANCHOR", "c2")]);
    s.getState().setActiveCircle("c2");
    s.getState().setMemberships([membership("OBSERVER", "c1"), membership("ANCHOR", "c2")]);
    expect(s.getState().activeCircleId).toBe("c2");
    expect(s.getState().activeRole()).toBe("ANCHOR");
    expect(s.getState().surfaces()).toEqual(["anchor"]);
  });
});

describe("policy slice (R3.2, R3.9)", () => {
  it("defaults to Elderly_Care when no mode is selected (R3.2)", () => {
    const s = createTestStore(createPolicySlice);
    expect(s.getState().activeModes()).toEqual([DEFAULT_PERSONA_MODE]);
    expect(s.getState().isModeActive("ELDERLY_CARE")).toBe(true);
  });

  it("supports multiple concurrent modes and toggling (R3.9)", () => {
    const s = createTestStore(createPolicySlice);
    s.getState().setModes(["SOLO_LIVING", "JOURNEY_WATCH", "SOLO_LIVING"]);
    expect(s.getState().activeModes()).toEqual(["SOLO_LIVING", "JOURNEY_WATCH"]);
    s.getState().toggleMode("SOLO_LIVING");
    expect(s.getState().isModeActive("SOLO_LIVING")).toBe(false);
    expect(s.getState().isModeActive("JOURNEY_WATCH")).toBe(true);
  });
});

describe("dashboard slice (R15)", () => {
  it("upserts anchors and filters escalating ones", () => {
    const s = createTestStore(createDashboardSlice);
    s.getState().setAnchors([
      { anchorId: "a1", preferredName: "Nani", state: "ALL_WELL" },
      { anchorId: "a2", preferredName: "Ravi", state: "ESCALATING" },
    ]);
    expect(s.getState().escalatingAnchors().map((a) => a.anchorId)).toEqual(["a2"]);

    s.getState().upsertAnchor({
      anchorId: "a1",
      preferredName: "Nani",
      state: "ESCALATING",
    });
    expect(s.getState().anchorById("a1")?.state).toBe("ESCALATING");
    expect(s.getState().anchors).toHaveLength(2);
  });
});
