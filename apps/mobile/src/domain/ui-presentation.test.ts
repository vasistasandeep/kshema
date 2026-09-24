/**
 * Presentation-logic tests for the Observer/Anchor surfaces (task 23.1).
 *
 * These exercise the pure decision helpers behind the surfaces under Node:
 * state → color/label, the Shield Paused disclosure gating, the escalation
 * stage labels, the Vitality Pulse card color, the Sparsh option sets, the
 * 04:00 Panchanga refresh calc, the cooperative Movement journey aggregation,
 * the Sanctuary banner, and the Brand_Lexicon / Banned_Term guarantees.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { palette, semanticColors, isBannedColor } from "@kshema/ui";
import type {
  AnchorWellBeing,
  IncidentStage,
  VitalityPulse,
  WellBeingState,
} from "@kshema/types";
import { BANNED_TERMS } from "./disclaimer.js";
import {
  BRAND_LEXICON,
  DEFAULT_MOVEMENT_MILESTONE,
  PANCHANGA_REFRESH_HOUR,
  SHIELD_PAUSED_GREY,
  SPARSH_OPTIONS,
  SPARSH_REPLY_OPTIONS,
  buildMovementJourney,
  buildSanctuaryBanner,
  containsBannedTerm,
  escalationStageLabel,
  panchangaCardDateFor,
  panchangaNeedsRefresh,
  toAnchorDashboardView,
  toVitalityPulseCard,
  wellBeingColor,
  wellBeingLabel,
  type MemberSteps,
} from "./ui-presentation.js";

const ALL_STATES: WellBeingState[] = ["ALL_WELL", "ESCALATING", "SHIELD_PAUSED"];
const ALL_STAGES: IncidentStage[] = [
  "STAGE_1_CONVERSATIONAL_WHATSAPP",
  "STAGE_2_GENTLE_DEVICE_CHIME",
  "STAGE_3_OBSERVER_SILENT_ALERT",
  "STAGE_4_HYPERLOCAL_DISPATCH",
];

describe("wellBeingColor (R15.2, R12.7, R20.6, R16.5)", () => {
  it("maps ALL_WELL → Sage, ESCALATING → Amber, SHIELD_PAUSED → neutral grey", () => {
    expect(wellBeingColor("ALL_WELL")).toBe(semanticColors.healthy);
    expect(wellBeingColor("ALL_WELL")).toBe(palette.mutedSageGreen); // #3D6B52
    expect(wellBeingColor("ESCALATING")).toBe(semanticColors.escalating);
    expect(wellBeingColor("ESCALATING")).toBe(palette.softAmber); // #D9822B
    expect(wellBeingColor("SHIELD_PAUSED")).toBe(SHIELD_PAUSED_GREY);
  });

  it("never returns clinical red or hospital blue for any state (R16.5)", () => {
    for (const state of ALL_STATES) {
      expect(isBannedColor(wellBeingColor(state))).toBe(false);
    }
    // The paused grey is distinct from the healthy Sage — paused is never "All Well".
    expect(wellBeingColor("SHIELD_PAUSED")).not.toBe(wellBeingColor("ALL_WELL"));
  });
});

describe("wellBeingLabel (R15.4, R20.6)", () => {
  it("uses the Brand_Lexicon labels", () => {
    expect(wellBeingLabel("ALL_WELL")).toBe(BRAND_LEXICON.stateAllWell);
    expect(wellBeingLabel("ESCALATING")).toBe(BRAND_LEXICON.stateCheckingIn);
    expect(wellBeingLabel("SHIELD_PAUSED")).toBe(BRAND_LEXICON.stateShieldPaused);
  });

  it("SHIELD_PAUSED is never presented as All Well (R20.6)", () => {
    expect(wellBeingLabel("SHIELD_PAUSED")).not.toBe(wellBeingLabel("ALL_WELL"));
  });
});

describe("escalationStageLabel (R15.3, R22.20)", () => {
  it("produces a calm label for every stage, with no alarm/countdown wording", () => {
    const forbidden = ["alarm", "alert", "panic", "emergency", "countdown", "!"];
    for (const stage of ALL_STAGES) {
      const label = escalationStageLabel(stage);
      expect(label.length).toBeGreaterThan(0);
      const lower = label.toLowerCase();
      for (const bad of forbidden) {
        expect(lower.includes(bad)).toBe(false);
      }
      expect(containsBannedTerm(label)).toBe(false);
    }
  });
});

describe("toAnchorDashboardView (R15.2–R15.4, R20.6, R20.7)", () => {
  const baseAnchor = (over: Partial<AnchorWellBeing>): AnchorWellBeing => ({
    anchorId: "anchor-1",
    preferredName: "Amma",
    state: "ALL_WELL",
    ...over,
  });

  it("ALL_WELL: Sage, All-well label, no disclosure, no stage", () => {
    const v = toAnchorDashboardView(baseAnchor({ state: "ALL_WELL" }));
    expect(v.color).toBe(semanticColors.healthy);
    expect(v.label).toBe(BRAND_LEXICON.stateAllWell);
    expect(v.disclosure).toBeUndefined();
    expect(v.stageLabel).toBeUndefined();
  });

  it("ESCALATING: Amber + stage label present, no disclosure (R15.3)", () => {
    const v = toAnchorDashboardView(
      baseAnchor({ state: "ESCALATING", escalationStage: "STAGE_2_GENTLE_DEVICE_CHIME" }),
    );
    expect(v.color).toBe(semanticColors.escalating);
    expect(v.stageLabel).toBe(escalationStageLabel("STAGE_2_GENTLE_DEVICE_CHIME"));
    expect(v.disclosure).toBeUndefined();
  });

  it("SHIELD_PAUSED: grey + disclosure present, no stage (R20.6, R20.7)", () => {
    const v = toAnchorDashboardView(baseAnchor({ state: "SHIELD_PAUSED" }));
    expect(v.color).toBe(SHIELD_PAUSED_GREY);
    expect(v.label).toBe(BRAND_LEXICON.stateShieldPaused);
    expect(v.disclosure).toBe(BRAND_LEXICON.shieldPausedDisclosure);
    expect(v.stageLabel).toBeUndefined();
  });

  it("disclosure appears iff SHIELD_PAUSED; stage label iff ESCALATING (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATES),
        fc.constantFrom(...ALL_STAGES),
        (state, stage) => {
          const v = toAnchorDashboardView(
            baseAnchor({ state, escalationStage: state === "ESCALATING" ? stage : undefined }),
          );
          expect(v.disclosure !== undefined).toBe(state === "SHIELD_PAUSED");
          expect(v.stageLabel !== undefined).toBe(state === "ESCALATING");
          expect(isBannedColor(v.color)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("toVitalityPulseCard (R7.3, R7.6)", () => {
  it("is presented in healthy Sage and carries the preferred name + context", () => {
    const pulse: VitalityPulse = {
      anchorId: "anchor-1",
      preferredName: "Appa",
      confirmedAt: "2024-01-01T07:30:00.000Z",
      stepContext: 240,
      weatherContext: "clear skies",
    };
    const card = toVitalityPulseCard(pulse);
    expect(card.color).toBe(semanticColors.healthy);
    expect(card.color).toBe(palette.mutedSageGreen);
    expect(card.preferredName).toBe("Appa");
    expect(card.stepContext).toBe(240);
    expect(card.weatherContext).toBe("clear skies");
    expect(containsBannedTerm(card.heading)).toBe(false);
  });

  it("omits optional context cleanly when absent", () => {
    const card = toVitalityPulseCard({
      anchorId: "a",
      preferredName: "Nani",
      confirmedAt: "2024-01-01T07:30:00.000Z",
    });
    expect(card.stepContext).toBeUndefined();
    expect(card.weatherContext).toBeUndefined();
  });
});

describe("Sparsh options (R22.8, R22.10)", () => {
  it("presents exactly the four morning options", () => {
    expect(SPARSH_OPTIONS.map((o) => o.type)).toEqual([
      "MORNING_CHAI",
      "PRANAM_BLESSING",
      "MORNING_SUN",
      "MARIGOLD_FLOWER",
    ]);
  });

  it("Anchor reply is a one-tap blessing or heart (R22.10)", () => {
    expect(SPARSH_REPLY_OPTIONS.map((o) => o.type)).toEqual([
      "PRANAM_BLESSING",
      "HEART_BLESSING",
    ]);
  });

  it("all option labels stay inside the Brand_Lexicon", () => {
    for (const o of [...SPARSH_OPTIONS, ...SPARSH_REPLY_OPTIONS]) {
      expect(containsBannedTerm(o.label)).toBe(false);
    }
  });
});

describe("Panchanga 04:00 refresh (R22.14)", () => {
  it("shows yesterday before 04:00 and today at/after 04:00", () => {
    expect(panchangaCardDateFor(3, "2024-06-02", "2024-06-01")).toBe("2024-06-01");
    expect(panchangaCardDateFor(PANCHANGA_REFRESH_HOUR, "2024-06-02", "2024-06-01")).toBe(
      "2024-06-02",
    );
    expect(panchangaCardDateFor(23, "2024-06-02", "2024-06-01")).toBe("2024-06-02");
  });

  it("needsRefresh flips exactly at the 04:00 boundary", () => {
    // Displaying yesterday at 03:00 is fine; at 04:00 it is stale.
    expect(panchangaNeedsRefresh(3, "2024-06-01", "2024-06-02", "2024-06-01")).toBe(false);
    expect(panchangaNeedsRefresh(4, "2024-06-01", "2024-06-02", "2024-06-01")).toBe(true);
  });

  it("property: target date is monotone in the local hour across the boundary", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), (hour) => {
        const target = panchangaCardDateFor(hour, "2024-06-02", "2024-06-01");
        expect(target).toBe(hour >= 4 ? "2024-06-02" : "2024-06-01");
      }),
      { numRuns: 100 },
    );
  });
});

describe("buildMovementJourney (R22.15, R22.16, R22.17)", () => {
  const members: MemberSteps[] = [
    { userId: "u1", preferredName: "Amma", weeklySteps: 30_000 },
    { userId: "u2", preferredName: "Beta", weeklySteps: 25_000 },
    { userId: "u3", preferredName: "Nani", weeklySteps: 20_000 },
  ];

  it("sums the whole Circle's weekly steps (R22.15)", () => {
    const j = buildMovementJourney(members);
    expect(j.totalSteps).toBe(75_000);
    expect(j.contributorCount).toBe(3);
  });

  it("flags the postcard when the milestone is reached, in celebration Temple Brass (R22.16, R22.19)", () => {
    const j = buildMovementJourney(members, 70_000);
    expect(j.milestoneReached).toBe(true);
    expect(j.progress).toBe(1);
    expect(j.celebrationColor).toBe(semanticColors.celebration);
    expect(j.celebrationColor).toBe(palette.templeBrass); // #D4A359
    expect(isBannedColor(j.celebrationColor)).toBe(false);
  });

  it("exposes no per-member ranking — only total + count (R22.17)", () => {
    const j = buildMovementJourney(members);
    // The view shape carries no array of members / positions.
    expect(Object.keys(j).sort()).toEqual(
      [
        "celebrationColor",
        "contributorCount",
        "heading",
        "milestoneReached",
        "milestoneTarget",
        "progress",
        "totalSteps",
      ].sort(),
    );
  });

  it("property: total is order-independent and progress is clamped to [0,1]", () => {
    const memberArb = fc.record({
      userId: fc.string({ minLength: 1, maxLength: 6 }),
      preferredName: fc.string({ minLength: 1, maxLength: 6 }),
      weeklySteps: fc.integer({ min: 0, max: 200_000 }),
    });
    fc.assert(
      fc.property(fc.array(memberArb, { maxLength: 8 }), (arr) => {
        const j = buildMovementJourney(arr, DEFAULT_MOVEMENT_MILESTONE);
        const reversed = buildMovementJourney([...arr].reverse(), DEFAULT_MOVEMENT_MILESTONE);
        expect(j.totalSteps).toBe(reversed.totalSteps);
        expect(j.progress).toBeGreaterThanOrEqual(0);
        expect(j.progress).toBeLessThanOrEqual(1);
        expect(j.milestoneReached).toBe(j.totalSteps >= DEFAULT_MOVEMENT_MILESTONE);
      }),
      { numRuns: 100 },
    );
  });
});

describe("buildSanctuaryBanner (R34.3)", () => {
  it("renders a calm Temple Brass banner mentioning the resumption time", () => {
    const banner = buildSanctuaryBanner("Sunday");
    expect(banner.color).toBe(semanticColors.celebration);
    expect(banner.color).toBe(palette.templeBrass);
    expect(banner.message).toContain("Sunday");
    expect(containsBannedTerm(banner.message)).toBe(false);
  });
});

describe("Brand_Lexicon copy stays inside the lexicon (R15.4, R16.5, R22.19)", () => {
  it("no approved string contains a Banned_Term", () => {
    for (const value of Object.values(BRAND_LEXICON)) {
      expect(containsBannedTerm(value)).toBe(false);
    }
  });

  it("containsBannedTerm catches each banned term case-insensitively", () => {
    for (const term of BANNED_TERMS) {
      expect(containsBannedTerm(`please avoid ${term.toUpperCase()} here`)).toBe(true);
    }
    expect(containsBannedTerm("Anchor is all well")).toBe(false);
  });
});
