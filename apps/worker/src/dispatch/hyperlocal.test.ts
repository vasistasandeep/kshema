/**
 * Unit tests for STAGE_4 hyperlocal dispatch content assembly (R14, task 13.1).
 *
 * All pure — no carrier, no DB, no timers. Verifies:
 *   - the dynamic message includes building / flat / society / door-access
 *     (R14.2 / R14.4);
 *   - the contact list is ordered Primary Observer → gate → neighbor
 *     (R14.1) and reused for the priority SMS (R14.3);
 *   - a member without `canTriggerIVR` is excluded from MANUAL dispatch
 *     (R14.5).
 */
import { describe, expect, it } from "vitest";

import {
  assembleHyperlocalContacts,
  assembleHyperlocalMessage,
  assembleHyperlocalDispatch,
  eligibleManualDispatchers,
  canManuallyDispatch,
  buildHyperlocalDispatchAudit,
  HYPERLOCAL_CONTACT_IDS,
  type HyperlocalProfileInput,
  type ManualDispatchMember,
} from "./hyperlocal.js";

const FULL_PROFILE: HyperlocalProfileInput = {
  building: "Tower B",
  flat: "1204",
  society: "Prestige Lakeside",
  doorAccess: "Gate code 4471, spare key with guard",
  primaryObserverPhone: "+911111111111",
  gatePhone: "+912222222222",
  neighborPhone: "+913333333333",
};

const CONTEXT = { incidentId: "inc-42", anchorName: "Kamala" };

describe("assembleHyperlocalMessage (R14.2 / R14.4)", () => {
  it("includes building, flat, society, and door-access details", () => {
    const msg = assembleHyperlocalMessage(FULL_PROFILE, CONTEXT);

    expect(msg).toContain("Tower B");
    expect(msg).toContain("1204");
    expect(msg).toContain("Prestige Lakeside");
    expect(msg).toContain("Gate code 4471, spare key with guard");
    // Dynamically woven with the Anchor name (R14.4).
    expect(msg).toContain("Kamala");
  });

  it("omits missing profile fields without leaving empty placeholders", () => {
    const msg = assembleHyperlocalMessage(
      {
        society: "Prestige Lakeside",
        flat: "1204",
        building: null,
        doorAccess: undefined,
      },
      CONTEXT,
    );

    expect(msg).toContain("Prestige Lakeside");
    expect(msg).toContain("1204");
    expect(msg).not.toContain("Building:");
    expect(msg).not.toContain("Door access:");
  });

  it("falls back to a generic subject when the Anchor name is absent", () => {
    const msg = assembleHyperlocalMessage(FULL_PROFILE, {
      incidentId: "inc-1",
    });
    expect(msg).toContain("the resident");
  });
});

describe("assembleHyperlocalContacts (R14.1)", () => {
  it("orders contacts Primary Observer, then gate, then neighbor", () => {
    const contacts = assembleHyperlocalContacts(FULL_PROFILE);

    expect(contacts.map((c) => c.id)).toEqual([
      HYPERLOCAL_CONTACT_IDS.primaryObserver,
      HYPERLOCAL_CONTACT_IDS.gate,
      HYPERLOCAL_CONTACT_IDS.neighbor,
    ]);
    expect(contacts[0]?.phone).toBe("+911111111111");
    expect(contacts[1]?.phone).toBe("+912222222222");
    expect(contacts[2]?.phone).toBe("+913333333333");
  });

  it("omits a role when its phone is absent but preserves the remaining order", () => {
    const contacts = assembleHyperlocalContacts({
      ...FULL_PROFILE,
      gatePhone: null,
    });

    expect(contacts.map((c) => c.id)).toEqual([
      HYPERLOCAL_CONTACT_IDS.primaryObserver,
      HYPERLOCAL_CONTACT_IDS.neighbor,
    ]);
  });
});

describe("assembleHyperlocalDispatch (R14.1 / R14.2 / R14.3 / R14.4)", () => {
  it("reuses the dynamic message as the priority SMS body", () => {
    const content = assembleHyperlocalDispatch(FULL_PROFILE, CONTEXT);

    expect(content.smsBody).toBe(content.messageText);
    expect(content.smsBody).toContain("Tower B");
    expect(content.contacts).toHaveLength(3);
  });
});

describe("eligibleManualDispatchers / canManuallyDispatch (R14.5)", () => {
  const members: ManualDispatchMember[] = [
    { id: "member-with-ivr", canTriggerIVR: true },
    { id: "member-without-ivr", canTriggerIVR: false },
  ];

  it("excludes a member lacking canTriggerIVR from manual dispatch", () => {
    const eligible = eligibleManualDispatchers(members);

    expect(eligible.map((m) => m.id)).toEqual(["member-with-ivr"]);
    expect(eligible.map((m) => m.id)).not.toContain("member-without-ivr");
  });

  it("canManuallyDispatch reflects the per-member authority flag", () => {
    expect(canManuallyDispatch({ id: "a", canTriggerIVR: true })).toBe(true);
    expect(canManuallyDispatch({ id: "b", canTriggerIVR: false })).toBe(false);
  });
});

describe("buildHyperlocalDispatchAudit (R14.6)", () => {
  it("records ordered contact ids and defaults to automatic STAGE_4 initiation", () => {
    const content = assembleHyperlocalDispatch(FULL_PROFILE, CONTEXT);
    const entry = buildHyperlocalDispatchAudit({
      incidentId: "inc-42",
      content,
      at: 1_700_000_000_000,
    });

    expect(entry.kind).toBe("hyperlocal_dispatch");
    expect(entry.incidentId).toBe("inc-42");
    expect(entry.initiatedBy).toBe("AUTOMATIC_STAGE_4");
    expect(entry.contactIds).toEqual([
      HYPERLOCAL_CONTACT_IDS.primaryObserver,
      HYPERLOCAL_CONTACT_IDS.gate,
      HYPERLOCAL_CONTACT_IDS.neighbor,
    ]);
  });

  it("records the initiating member id for a manual dispatch", () => {
    const content = assembleHyperlocalDispatch(FULL_PROFILE, CONTEXT);
    const entry = buildHyperlocalDispatchAudit({
      incidentId: "inc-42",
      content,
      at: 1_700_000_000_000,
      initiatedBy: "MANUAL",
      initiatedByMemberId: "member-with-ivr",
    });

    expect(entry.initiatedBy).toBe("MANUAL");
    expect(entry.initiatedByMemberId).toBe("member-with-ivr");
  });
});
