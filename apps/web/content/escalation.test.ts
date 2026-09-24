import { describe, it, expect } from "vitest";
import {
  ESCALATION_LADDER,
  FLIGHT_RECORDER_EXPLAINER,
} from "./escalation";
import { getTranslator } from "./catalog";
import { SUPPORTED_LOCALES } from "./locales";

describe("Escalation ladder + Flight_Recorder explainer content (R30.2)", () => {
  it("has exactly four stages in strict 1..4 order", () => {
    expect(ESCALATION_LADDER).toHaveLength(4);
    const orders = ESCALATION_LADDER.map((s) => s.order);
    expect(orders).toEqual([1, 2, 3, 4]);
  });

  it("uses only approved semantic palette roles (no clinical color)", () => {
    const allowed = new Set(["healthy", "escalating", "primaryAction"]);
    for (const stage of ESCALATION_LADDER) {
      expect(allowed.has(stage.paletteRole)).toBe(true);
    }
  });

  it("resolves every stage title/description in all five languages", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = getTranslator(locale);
      for (const stage of ESCALATION_LADDER) {
        expect(t(stage.titleKey).trim().length).toBeGreaterThan(0);
        expect(t(stage.descriptionKey).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("resolves the Flight_Recorder explainer heading and points in all languages", () => {
    expect(FLIGHT_RECORDER_EXPLAINER.pointKeys.length).toBeGreaterThanOrEqual(4);
    for (const locale of SUPPORTED_LOCALES) {
      const t = getTranslator(locale);
      expect(t(FLIGHT_RECORDER_EXPLAINER.headingKey).trim().length).toBeGreaterThan(0);
      for (const key of FLIGHT_RECORDER_EXPLAINER.pointKeys) {
        expect(t(key).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
