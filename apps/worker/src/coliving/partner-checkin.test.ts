import { describe, expect, it, vi } from "vitest";

import type { HouseholdProfileView } from "./attribution.js";
import {
  CO_LIVING_PARTNER_CONFIRMED,
  runPartnerCheckIn,
  type PartnerCheckIn,
  type PartnerCheckInDeps,
  type PartnerResponse,
} from "./partner-checkin.js";

const PROFILE: HouseholdProfileView = {
  householdName: "Rao residence",
  anchorIds: ["anchor-a", "anchor-b"],
  sharedWifiBssids: ["aa:bb:cc:dd:ee:ff"],
  sharedMediaDeviceIds: ["chromecast-living-room"],
};

function makeDeps(
  overrides: Partial<PartnerCheckInDeps> = {},
): PartnerCheckInDeps & {
  notifyPartner: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  lookupHousehold: ReturnType<typeof vi.fn>;
} {
  const lookupHousehold = vi.fn().mockResolvedValue(PROFILE);
  const notifyPartner = vi
    .fn<(checkIn: PartnerCheckIn) => Promise<PartnerResponse>>()
    .mockResolvedValue({ confirmedSafe: false });
  const resolve = vi.fn().mockResolvedValue(undefined);
  return {
    lookupHousehold,
    notifyPartner,
    resolve,
    ...overrides,
  } as never;
}

describe("runPartnerCheckIn — quiet STAGE_1 check-in delivery (R35.3)", () => {
  it("delivers a quiet high-priority STAGE_1 check-in to the co-living partner", async () => {
    const deps = makeDeps();
    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "anchor-a",
      now: 1000,
    });

    expect(deps.notifyPartner).toHaveBeenCalledTimes(1);
    const checkIn = deps.notifyPartner.mock.calls[0]![0] as PartnerCheckIn;
    expect(checkIn.stage).toBe("STAGE_1_CONVERSATIONAL_WHATSAPP");
    expect(checkIn.quiet).toBe(true);
    expect(checkIn.priority).toBe("high");
    expect(checkIn.partnerAnchorIds).toEqual(["anchor-b"]);
    expect(checkIn.subjectAnchorId).toBe("anchor-a");
    expect(result.coLiving).toBe(true);
    expect(result.checkInDelivered).toBe(true);
  });

  it("is a no-op for a non-co-living Anchor (permits normal escalation)", async () => {
    const deps = makeDeps({ lookupHousehold: vi.fn().mockResolvedValue(null) });
    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "solo-anchor",
      now: 1000,
    });
    expect(deps.notifyPartner).not.toHaveBeenCalled();
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(result.coLiving).toBe(false);
    expect(result.mayProceedToExternalDispatch).toBe(true);
  });

  it("is a no-op for a sole resident household (no partner to notify)", async () => {
    const deps = makeDeps({
      lookupHousehold: vi
        .fn()
        .mockResolvedValue({ ...PROFILE, anchorIds: ["anchor-a"] }),
    });
    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "anchor-a",
      now: 1000,
    });
    expect(deps.notifyPartner).not.toHaveBeenCalled();
    expect(result.coLiving).toBe(false);
    expect(result.mayProceedToExternalDispatch).toBe(true);
  });
});

describe("runPartnerCheckIn — resolution on partner confirmation (R35.4)", () => {
  it("resolves with CO_LIVING_PARTNER_CONFIRMED when the partner confirms safe", async () => {
    const deps = makeDeps({
      notifyPartner: vi.fn().mockResolvedValue({ confirmedSafe: true }),
    });
    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "anchor-a",
      now: 4242,
    });

    expect(deps.resolve).toHaveBeenCalledTimes(1);
    expect(deps.resolve).toHaveBeenCalledWith({
      incidentId: "inc-1",
      source: CO_LIVING_PARTNER_CONFIRMED,
      now: 4242,
    });
    expect(CO_LIVING_PARTNER_CONFIRMED).toBe("CO_LIVING_PARTNER_CONFIRMED");
    expect(result.resolved).toBe(true);
    expect(result.mayProceedToExternalDispatch).toBe(false);
  });

  it("does NOT resolve and permits external dispatch when the partner does not confirm", async () => {
    const deps = makeDeps({
      notifyPartner: vi.fn().mockResolvedValue({ confirmedSafe: false }),
    });
    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "anchor-a",
      now: 1000,
    });
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(result.resolved).toBe(false);
    expect(result.mayProceedToExternalDispatch).toBe(true);
  });
});

describe("runPartnerCheckIn — ordering: partner check-in BEFORE external dispatch (R35.3)", () => {
  it("delivers the partner check-in and resolves before any external dispatch would occur", async () => {
    const order: string[] = [];
    // Simulate the escalation caller: run the partner step, and ONLY dispatch
    // externally if the step permits it.
    const externalDispatch = vi.fn(() => {
      order.push("external_dispatch");
    });

    const deps = makeDeps({
      notifyPartner: vi.fn().mockImplementation(async () => {
        order.push("partner_checkin");
        return { confirmedSafe: true };
      }),
      resolve: vi.fn().mockImplementation(async () => {
        order.push("resolve");
      }),
    });

    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "anchor-a",
      now: 1000,
    });
    if (result.mayProceedToExternalDispatch) externalDispatch();

    // The partner check-in fires first; the incident resolves; external
    // dispatch never runs because the partner confirmed (R35.3/R35.4).
    expect(order).toEqual(["partner_checkin", "resolve"]);
    expect(externalDispatch).not.toHaveBeenCalled();
  });

  it("when the partner does not confirm, the check-in STILL fires before external dispatch", async () => {
    const order: string[] = [];
    const externalDispatch = vi.fn(() => {
      order.push("external_dispatch");
    });

    const deps = makeDeps({
      notifyPartner: vi.fn().mockImplementation(async () => {
        order.push("partner_checkin");
        return { confirmedSafe: false };
      }),
    });

    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "anchor-a",
      now: 1000,
    });
    if (result.mayProceedToExternalDispatch) externalDispatch();

    // Ordering guarantee: the partner check-in is delivered strictly before the
    // external Hyperlocal dispatch (R35.3).
    expect(order).toEqual(["partner_checkin", "external_dispatch"]);
    expect(order.indexOf("partner_checkin")).toBeLessThan(
      order.indexOf("external_dispatch"),
    );
  });

  it("accepts synchronous seams (hermetic wiring)", async () => {
    const deps: PartnerCheckInDeps = {
      lookupHousehold: () => PROFILE,
      notifyPartner: () => ({ confirmedSafe: true }),
      resolve: () => {},
    };
    const result = await runPartnerCheckIn(deps, {
      incidentId: "inc-1",
      anchorId: "anchor-b",
      now: 1,
    });
    expect(result.resolved).toBe(true);
    expect(result.partnerAnchorIds).toEqual(["anchor-a"]);
  });
});
