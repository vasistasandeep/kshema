import { describe, it, expect } from "vitest";

import {
  palette,
  semanticColors,
  bannedColors,
  isBannedColor,
} from "./tokens";
import { kshemaPreset, brandColors, UI_PACKAGE } from "./index";

const HEX = /^#[0-9a-fA-F]{6}$/;

describe("brand palette (R16.2, R16.3, R22.19)", () => {
  it("defines the six approved colors with exact hex values", () => {
    expect(palette).toEqual({
      sandalwoodCream: "#FDFBF7",
      terracotta: "#C85A32",
      deepCharcoal: "#1F2421",
      mutedSageGreen: "#3D6B52",
      softAmber: "#D9822B",
      templeBrass: "#D4A359",
    });
  });

  it("uses only valid 6-digit hex values", () => {
    for (const value of Object.values(palette)) {
      expect(value).toMatch(HEX);
    }
  });
});

describe("semantic role tokens (R16.2, R16.3, R22.19)", () => {
  it("maps each UI role onto a palette color", () => {
    expect(semanticColors.canvas).toBe(palette.sandalwoodCream);
    expect(semanticColors.primaryAction).toBe(palette.terracotta);
    expect(semanticColors.typography).toBe(palette.deepCharcoal);
    expect(semanticColors.healthy).toBe(palette.mutedSageGreen);
    expect(semanticColors.escalating).toBe(palette.softAmber);
    expect(semanticColors.celebration).toBe(palette.templeBrass);
  });
});

describe("excluded clinical/hospital colors (R16.4)", () => {
  it("never includes clinical red or hospital blue in the palette", () => {
    const values = Object.values(palette).map((v) => v.toLowerCase());
    expect(values).not.toContain(bannedColors.clinicalRed.toLowerCase());
    expect(values).not.toContain(bannedColors.hospitalBlue.toLowerCase());
  });

  it("never includes the banned colors in the shared preset", () => {
    const presetValues = Object.values(
      kshemaPreset.theme.extend.colors,
    ).map((v) => v.toLowerCase());
    expect(presetValues).not.toContain(bannedColors.clinicalRed.toLowerCase());
    expect(presetValues).not.toContain(bannedColors.hospitalBlue.toLowerCase());
  });

  it("flags banned colors case-insensitively", () => {
    expect(isBannedColor("#FF0000")).toBe(true);
    expect(isBannedColor("#ff0000")).toBe(true);
    expect(isBannedColor("  #0066FF  ")).toBe(true);
    expect(isBannedColor(palette.terracotta)).toBe(false);
  });
});

describe("shared Tailwind/NativeWind preset", () => {
  it("exposes every palette color for class generation", () => {
    const colors = kshemaPreset.theme.extend.colors;
    expect(colors["sandalwood-cream"]).toBe(palette.sandalwoodCream);
    expect(colors["terracotta"]).toBe(palette.terracotta);
    expect(colors["deep-charcoal"]).toBe(palette.deepCharcoal);
    expect(colors["muted-sage-green"]).toBe(palette.mutedSageGreen);
    expect(colors["soft-amber"]).toBe(palette.softAmber);
    expect(colors["temple-brass"]).toBe(palette.templeBrass);
  });

  it("exposes semantic role aliases", () => {
    const colors = kshemaPreset.theme.extend.colors;
    expect(colors["canvas"]).toBe(semanticColors.canvas);
    expect(colors["primary-action"]).toBe(semanticColors.primaryAction);
    expect(colors["typography"]).toBe(semanticColors.typography);
    expect(colors["healthy"]).toBe(semanticColors.healthy);
    expect(colors["escalating"]).toBe(semanticColors.escalating);
    expect(colors["celebration"]).toBe(semanticColors.celebration);
  });

  it("has the same colors on the preset and the exported brandColors map", () => {
    expect(kshemaPreset.theme.extend.colors).toEqual(brandColors);
  });

  it("keeps the package identity export", () => {
    expect(UI_PACKAGE).toBe("@kshema/ui");
  });
});
