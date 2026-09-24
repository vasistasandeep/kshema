import { describe, expect, it } from "vitest";
import {
  BANNED_TERMS,
  DISCLAIMER_STATEMENTS,
  DISCLAIMER_VERSION,
  canActivateAmbientShield,
  findBannedTerms,
  recordDisclaimerAcceptance,
} from "./disclaimer.js";

describe("Safety_Disclaimer content (R26.1, R26.4)", () => {
  it("states the mandatory disclosures (utility / not-medical / not-emergency / dependencies)", () => {
    const all = DISCLAIMER_STATEMENTS.join(" ").toLowerCase();
    expect(all).toContain("routine-assurance");
    expect(all).toContain("not a licensed medical device");
    expect(all).toContain("not an official emergency service");
    expect(all).toContain("cellular networks");
    expect(all).toContain("push notification");
    expect(all).toContain("gateways");
  });

  it("excludes every Banned_Term (R26.4)", () => {
    for (const statement of DISCLAIMER_STATEMENTS) {
      expect(findBannedTerms(statement)).toEqual([]);
    }
  });

  it("findBannedTerms detects a banned term case-insensitively", () => {
    expect(findBannedTerms("Constant SURVEILLANCE of your parent")).toContain(
      "surveillance",
    );
    // sanity: our banned list is non-empty
    expect(BANNED_TERMS.length).toBeGreaterThan(0);
  });
});

describe("acceptance record + activation gate (R26.2, R26.3)", () => {
  it("records the current version and an ISO timestamp", () => {
    const now = new Date("2024-06-15T08:00:00.000Z");
    const acceptance = recordDisclaimerAcceptance(now);
    expect(acceptance.version).toBe(DISCLAIMER_VERSION);
    expect(acceptance.acceptedAt).toBe("2024-06-15T08:00:00.000Z");
  });

  it("forbids Ambient_Shield activation without acceptance (R26.2)", () => {
    expect(canActivateAmbientShield(null)).toBe(false);
    expect(canActivateAmbientShield(undefined)).toBe(false);
  });

  it("permits activation only for an acceptance of the current version", () => {
    expect(canActivateAmbientShield(recordDisclaimerAcceptance())).toBe(true);
    expect(
      canActivateAmbientShield({ version: "1999-01-01", acceptedAt: "x" }),
    ).toBe(false);
  });
});
