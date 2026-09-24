import { describe, expect, it } from "vitest";

import type { ConfirmingSignal } from "../personas/confirming-signal.js";
import {
  attributeGhostSignal,
  coLivingPartnersOf,
  evaluateCoLivingConfirmation,
  isHouseholdConfirmed,
  isIndividuallyConfirmed,
  isRoutineConfirmedForCoLivingAnchor,
  type GhostSignalView,
  type HouseholdProfileView,
} from "./attribution.js";

const PROFILE: HouseholdProfileView = {
  householdName: "Rao residence",
  anchorIds: ["anchor-a", "anchor-b"],
  sharedWifiBssids: ["aa:bb:cc:dd:ee:ff"],
  sharedMediaDeviceIds: ["chromecast-living-room"],
};

function ghost(overrides: Partial<GhostSignalView> = {}): GhostSignalView {
  return {
    anchorId: "anchor-a",
    signalType: "MEDIA_DEVICE_WAKE",
    source: "chromecast-living-room",
    ...overrides,
  };
}

describe("attributeGhostSignal / isHouseholdConfirmed (R35.1, R35.2)", () => {
  it("attributes a shared media-device wake as household activity confirmed", () => {
    const g = ghost({
      signalType: "MEDIA_DEVICE_WAKE",
      source: "chromecast-living-room",
    });
    expect(attributeGhostSignal(g, PROFILE)).toBe("HOUSEHOLD");
    expect(isHouseholdConfirmed(g, PROFILE)).toBe(true);
  });

  it("attributes a shared Wi-Fi re-association as household activity confirmed", () => {
    const g = ghost({
      signalType: "HOME_WIFI_REASSOCIATION",
      source: "aa:bb:cc:dd:ee:ff",
    });
    expect(attributeGhostSignal(g, PROFILE)).toBe("HOUSEHOLD");
    expect(isHouseholdConfirmed(g, PROFILE)).toBe(true);
  });

  it("attributes a non-shared media device as INDIVIDUAL", () => {
    const g = ghost({ signalType: "MEDIA_DEVICE_WAKE", source: "private-tablet" });
    expect(attributeGhostSignal(g, PROFILE)).toBe("INDIVIDUAL");
    expect(isHouseholdConfirmed(g, PROFILE)).toBe(false);
  });

  it("attributes a non-shared BSSID as INDIVIDUAL", () => {
    const g = ghost({
      signalType: "HOME_WIFI_REASSOCIATION",
      source: "11:22:33:44:55:66",
    });
    expect(attributeGhostSignal(g, PROFILE)).toBe("INDIVIDUAL");
  });
});

describe("isIndividuallyConfirmed (R35.2)", () => {
  it("is true for a screen unlock", () => {
    const signals: ConfirmingSignal[] = [{ type: "screen_unlock", at: 1 }];
    expect(isIndividuallyConfirmed(signals)).toBe(true);
  });

  it("is true for a positive step delta", () => {
    const signals: ConfirmingSignal[] = [
      { type: "step_delta", at: 1, stepDelta: 12 },
    ];
    expect(isIndividuallyConfirmed(signals)).toBe(true);
  });

  it("is false for a zero/negative step delta", () => {
    expect(
      isIndividuallyConfirmed([{ type: "step_delta", at: 1, stepDelta: 0 }]),
    ).toBe(false);
    expect(
      isIndividuallyConfirmed([{ type: "step_delta", at: 1, stepDelta: -3 }]),
    ).toBe(false);
  });

  it("does NOT treat charger-unplug or a generic ghost signal as individual (R35.2 is stricter)", () => {
    expect(isIndividuallyConfirmed([{ type: "charger_unplug", at: 1 }])).toBe(
      false,
    );
    expect(isIndividuallyConfirmed([{ type: "ghost_signal", at: 1 }])).toBe(
      false,
    );
  });

  it("is false for an empty signal set", () => {
    expect(isIndividuallyConfirmed([])).toBe(false);
  });
});

describe("isRoutineConfirmedForCoLivingAnchor — the R35.2 combiner", () => {
  it("household activity confirms an Anchor that does NOT require independent confirmation", () => {
    expect(
      isRoutineConfirmedForCoLivingAnchor({
        requiresIndependentConfirmation: false,
        householdConfirmed: true,
        individuallyConfirmed: false,
      }),
    ).toBe(true);
  });

  it("a household signal ALONE does NOT confirm an Anchor requiring independent confirmation (R35.2)", () => {
    expect(
      isRoutineConfirmedForCoLivingAnchor({
        requiresIndependentConfirmation: true,
        householdConfirmed: true,
        individuallyConfirmed: false,
      }),
    ).toBe(false);
  });

  it("an individual signal DOES confirm an Anchor requiring independent confirmation (R35.2)", () => {
    expect(
      isRoutineConfirmedForCoLivingAnchor({
        requiresIndependentConfirmation: true,
        householdConfirmed: true,
        individuallyConfirmed: true,
      }),
    ).toBe(true);
    // individual alone (no household signal) also confirms.
    expect(
      isRoutineConfirmedForCoLivingAnchor({
        requiresIndependentConfirmation: true,
        householdConfirmed: false,
        individuallyConfirmed: true,
      }),
    ).toBe(true);
  });

  it("neither household nor individual ⇒ not confirmed", () => {
    expect(
      isRoutineConfirmedForCoLivingAnchor({
        requiresIndependentConfirmation: false,
        householdConfirmed: false,
        individuallyConfirmed: false,
      }),
    ).toBe(false);
  });

  it("matches the design truth table: confirmed = individual || (household && !requiresIndependent)", () => {
    for (const requiresIndependentConfirmation of [true, false]) {
      for (const householdConfirmed of [true, false]) {
        for (const individuallyConfirmed of [true, false]) {
          const expected =
            individuallyConfirmed ||
            (householdConfirmed && !requiresIndependentConfirmation);
          expect(
            isRoutineConfirmedForCoLivingAnchor({
              requiresIndependentConfirmation,
              householdConfirmed,
              individuallyConfirmed,
            }),
          ).toBe(expected);
        }
      }
    }
  });
});

describe("evaluateCoLivingConfirmation — end-to-end over raw signals (R35.2)", () => {
  it("an independent-confirmation Anchor is NOT confirmed by a shared ghost signal alone", () => {
    const confirmed = evaluateCoLivingConfirmation({
      requiresIndependentConfirmation: true,
      ghostSignals: [
        { signalType: "MEDIA_DEVICE_WAKE", source: "chromecast-living-room" },
      ],
      confirmingSignals: [],
      profile: PROFILE,
    });
    expect(confirmed).toBe(false);
  });

  it("an independent-confirmation Anchor IS confirmed by an individual screen unlock", () => {
    const confirmed = evaluateCoLivingConfirmation({
      requiresIndependentConfirmation: true,
      ghostSignals: [
        { signalType: "MEDIA_DEVICE_WAKE", source: "chromecast-living-room" },
      ],
      confirmingSignals: [{ type: "screen_unlock", at: 1 }],
      profile: PROFILE,
    });
    expect(confirmed).toBe(true);
  });

  it("an independent-confirmation Anchor IS confirmed by a positive step delta", () => {
    const confirmed = evaluateCoLivingConfirmation({
      requiresIndependentConfirmation: true,
      ghostSignals: [],
      confirmingSignals: [{ type: "step_delta", at: 1, stepDelta: 7 }],
      profile: PROFILE,
    });
    expect(confirmed).toBe(true);
  });

  it("a non-independent Anchor is confirmed by household activity alone", () => {
    const confirmed = evaluateCoLivingConfirmation({
      requiresIndependentConfirmation: false,
      ghostSignals: [
        { signalType: "HOME_WIFI_REASSOCIATION", source: "aa:bb:cc:dd:ee:ff" },
      ],
      confirmingSignals: [],
      profile: PROFILE,
    });
    expect(confirmed).toBe(true);
  });
});

describe("coLivingPartnersOf (R35.3 addressing)", () => {
  it("returns the other household members", () => {
    expect(coLivingPartnersOf("anchor-a", PROFILE)).toEqual(["anchor-b"]);
    expect(coLivingPartnersOf("anchor-b", PROFILE)).toEqual(["anchor-a"]);
  });

  it("returns [] for an Anchor not in the household", () => {
    expect(coLivingPartnersOf("stranger", PROFILE)).toEqual([]);
  });

  it("returns [] for a sole resident", () => {
    expect(
      coLivingPartnersOf("anchor-a", { ...PROFILE, anchorIds: ["anchor-a"] }),
    ).toEqual([]);
  });
});
