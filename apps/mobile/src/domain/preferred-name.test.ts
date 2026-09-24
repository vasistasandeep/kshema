import { describe, expect, it } from "vitest";
import {
  isValidPreferredName,
  normalizePreferredName,
  PREFERRED_NAME_MAX_LENGTH,
  requiresPreferredNamePrompt,
} from "./preferred-name.js";

describe("preferred-name prompt gate (R1.7)", () => {
  it("prompts when no name is stored", () => {
    expect(requiresPreferredNamePrompt(null)).toBe(true);
    expect(requiresPreferredNamePrompt(undefined)).toBe(true);
    expect(requiresPreferredNamePrompt("   ")).toBe(true);
  });

  it("does not prompt once a name is provided", () => {
    expect(requiresPreferredNamePrompt("Amma")).toBe(false);
  });
});

describe("preferred-name normalization + validation", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizePreferredName("  Ravi   Kumar ")).toBe("Ravi Kumar");
  });

  it("accepts a reasonable name and rejects blank / over-long", () => {
    expect(isValidPreferredName("Nani")).toBe(true);
    expect(isValidPreferredName("   ")).toBe(false);
    expect(isValidPreferredName("a".repeat(PREFERRED_NAME_MAX_LENGTH + 1))).toBe(
      false,
    );
  });
});
