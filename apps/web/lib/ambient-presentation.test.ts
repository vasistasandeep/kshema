/**
 * Ambient Desk Mode presentation tests (R28.6, R28.7, R28.8, R28.18).
 *
 * Asserts the brand-locked colors and Brand_Lexicon labels: Sage "All Well",
 * Amber escalation with action controls, and a neutral paused disclosure.
 * Also guards against any Banned_Term leaking into the status labels.
 */
import { describe, expect, it } from "vitest";
import type { DashboardTick } from "@kshema/types";
import { palette } from "@kshema/ui";
import { formatDualClock, heroFor, lastConfirmedLabel } from "./ambient-presentation";

const BANNED = [
  "monitoring",
  "surveillance",
  "tracking",
  "patient",
  "elderly watch",
  "supervision",
  "fall alarm",
  "panic button",
];

function tick(over: Partial<DashboardTick>): DashboardTick {
  return {
    anchorId: "a1",
    preferredName: "Amma",
    state: "ALL_WELL",
    observerTime: "2024-06-01T09:00:00.000Z",
    anchorTime: "2024-06-01T14:30:00.000Z",
    anchorTimezone: "Asia/Kolkata",
    ...over,
  };
}

describe("Ambient Desk Mode presentation", () => {
  it("healthy state → Sage 'All Well' with no action controls (R28.7)", () => {
    const hero = heroFor(tick({ state: "ALL_WELL" }));
    expect(hero.hex).toBe(palette.mutedSageGreen);
    expect(hero.bgClass).toBe("bg-healthy");
    expect(hero.label).toBe("All Well");
    expect(hero.showActions).toBe(false);
  });

  it("escalating state → Amber with stage + action controls (R28.8)", () => {
    const hero = heroFor(
      tick({
        state: "ESCALATING",
        escalationStage: "STAGE_4_HYPERLOCAL_DISPATCH",
      }),
    );
    expect(hero.hex).toBe(palette.softAmber);
    expect(hero.bgClass).toBe("bg-escalating");
    expect(hero.showActions).toBe(true);
    expect(hero.label.toLowerCase()).toContain("stage 4");
  });

  it("paused state → neutral disclosure, no clinical color", () => {
    const hero = heroFor(tick({ state: "SHIELD_PAUSED" }));
    expect(hero.hex).toBe(palette.templeBrass);
    expect(hero.hex).not.toBe("#FF0000");
    expect(hero.hex).not.toBe("#0066FF");
    expect(hero.showActions).toBe(false);
  });

  it("no status label contains a Banned_Term (R28.18)", () => {
    const labels = [
      heroFor(tick({ state: "ALL_WELL" })).label,
      heroFor(
        tick({ state: "ESCALATING", escalationStage: "STAGE_1_CONVERSATIONAL_WHATSAPP" }),
      ).label,
      heroFor(tick({ state: "SHIELD_PAUSED" })).label,
    ].map((s) => s.toLowerCase());
    for (const label of labels) {
      for (const term of BANNED) {
        expect(label).not.toContain(term);
      }
    }
  });

  it("formats a dual-timezone clock contrasting Observer and Anchor (R28.6)", () => {
    const clock = formatDualClock(tick({}), "America/New_York");
    expect(clock.anchorTimezone).toBe("Asia/Kolkata");
    expect(clock.observerLabel).toBeTruthy();
    expect(clock.anchorLabel).toBeTruthy();
    // Different zones for the same instant should not read identically.
    expect(clock.observerLabel).not.toBe(clock.anchorLabel);
  });

  it("builds a verified-morning confirmation line when present", () => {
    const label = lastConfirmedLabel(
      tick({ lastConfirmationAt: "2024-06-01T01:30:00.000Z" }),
    );
    expect(label).toContain("Verified morning wakefulness");
    expect(lastConfirmedLabel(tick({}))).toBeUndefined();
  });
});
