import { describe, it, expect } from "vitest";
import {
  DEFAULT_CURRENCY,
  PRICE_BOOK,
  SUPPORTED_CURRENCIES,
  detectCurrency,
  formatPrice,
  getPlanPrice,
  isCurrency,
  type PlanId,
} from "./pricing";

const PLANS: PlanId[] = ["trial", "pro_monthly", "pro_annual", "shield_paused"];

describe("Localized pricing + geo currency detection (R30.3, R30.4)", () => {
  it("supports exactly the five presentment currencies", () => {
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual(
      ["AED", "GBP", "INR", "SGD", "USD"].sort(),
    );
  });

  it("maps known geo countries to their currency", () => {
    expect(detectCurrency("IN")).toBe("INR");
    expect(detectCurrency("US")).toBe("USD");
    expect(detectCurrency("GB")).toBe("GBP");
    expect(detectCurrency("AE")).toBe("AED");
    expect(detectCurrency("SG")).toBe("SGD");
  });

  it("falls back to USD for unknown or missing geography", () => {
    expect(detectCurrency(null)).toBe(DEFAULT_CURRENCY);
    expect(detectCurrency("ZZ")).toBe(DEFAULT_CURRENCY);
    expect(detectCurrency(undefined)).toBe("USD");
  });

  it("lets a valid manual override win over geography (case-insensitive)", () => {
    expect(detectCurrency("IN", "usd")).toBe("USD");
    expect(detectCurrency("US", "SGD")).toBe("SGD");
    // Invalid override is ignored, geography stands.
    expect(detectCurrency("IN", "XYZ")).toBe("INR");
  });

  it("override always resolves to a supported currency when valid", () => {
    const countries = [null, undefined, "IN", "US", "GB", "AE", "SG", "ZZ", ""];
    for (const cur of SUPPORTED_CURRENCIES) {
      for (const country of countries) {
        expect(detectCurrency(country, cur)).toBe(cur);
        // Lower-case override is normalized too.
        expect(detectCurrency(country, cur.toLowerCase())).toBe(cur);
      }
    }
  });

  it("prices every plan in every currency (shows Trial, Pro monthly/annual, Shield Paused)", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      for (const plan of PLANS) {
        const price = getPlanPrice(currency, plan);
        expect(price.amount).toBeGreaterThanOrEqual(0);
        expect(["trial", "month", "year", "paused"]).toContain(price.cadence);
      }
      // Free states are zero-cost.
      expect(PRICE_BOOK[currency].trial.amount).toBe(0);
      expect(PRICE_BOOK[currency].shield_paused.amount).toBe(0);
      // Paid states are positive.
      expect(PRICE_BOOK[currency].pro_monthly.amount).toBeGreaterThan(0);
      expect(PRICE_BOOK[currency].pro_annual.amount).toBeGreaterThan(0);
    }
  });

  it("formats prices with the currency symbol and no fractional digits", () => {
    const formatted = formatPrice("USD", 5);
    expect(formatted).toContain("5");
    expect(formatted).not.toContain(".00");
    expect(isCurrency("INR")).toBe(true);
    expect(isCurrency("JPY")).toBe(false);
  });
});
