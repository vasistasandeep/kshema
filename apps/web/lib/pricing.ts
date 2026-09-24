/**
 * Localized subscription pricing + geo-based currency detection (R30.3, R30.4).
 *
 * The public portal presents the 14-day Trial_Period, the monthly and annual
 * Pro_Tier plans, and the Shield_Paused_State (R30.3), with prices localized in
 * INR, USD, GBP, AED, and SGD. Currency is detected from the edge geo country
 * header (ISO 3166-1 alpha-2) with a manual override, falling back to USD.
 *
 * This module is framework-agnostic pure TypeScript so it can be unit-tested
 * and reused by both the SSG pages and any edge middleware.
 *
 * Requirements: 30.3, 30.4.
 */

/** The five presentment currencies supported on the public portal. */
export const SUPPORTED_CURRENCIES = ["INR", "USD", "GBP", "AED", "SGD"] as const;

/** A supported presentment currency code. */
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** The default currency when geography cannot be determined. */
export const DEFAULT_CURRENCY: Currency = "USD";

/** Per-currency display metadata. */
export interface CurrencyMeta {
  readonly code: Currency;
  readonly symbol: string;
  /** BCP-47 locale used for `Intl.NumberFormat` grouping/spacing. */
  readonly numberLocale: string;
}

export const CURRENCY_META: Readonly<Record<Currency, CurrencyMeta>> = {
  INR: { code: "INR", symbol: "₹", numberLocale: "en-IN" },
  USD: { code: "USD", symbol: "$", numberLocale: "en-US" },
  GBP: { code: "GBP", symbol: "£", numberLocale: "en-GB" },
  AED: { code: "AED", symbol: "د.إ", numberLocale: "en-AE" },
  SGD: { code: "SGD", symbol: "S$", numberLocale: "en-SG" },
};

/**
 * Maps an ISO 3166-1 alpha-2 country code to a presentment currency. Countries
 * outside the direct map fall back to {@link DEFAULT_CURRENCY} (USD).
 */
const COUNTRY_TO_CURRENCY: Readonly<Record<string, Currency>> = {
  IN: "INR",
  US: "USD",
  GB: "GBP",
  AE: "AED",
  SG: "SGD",
};

/** Type guard: is the string one of the supported currencies? */
export function isCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/**
 * Resolves the presentment currency from an edge geo country code and an
 * optional manual override. The override wins when it names a supported
 * currency; otherwise the country is mapped; otherwise the default is used.
 */
export function detectCurrency(
  countryCode: string | null | undefined,
  override?: string | null,
): Currency {
  if (override && isCurrency(override.toUpperCase())) {
    return override.toUpperCase() as Currency;
  }
  if (countryCode) {
    const mapped = COUNTRY_TO_CURRENCY[countryCode.trim().toUpperCase()];
    if (mapped) return mapped;
  }
  return DEFAULT_CURRENCY;
}

/** The subscription plans presented on the portal. */
export type PlanId = "trial" | "pro_monthly" | "pro_annual" | "shield_paused";

/** A single plan's price in one currency (minor-unit-free integer amounts). */
export interface PlanPrice {
  /** Whole-currency-unit amount (0 for free states). */
  readonly amount: number;
  /** Billing cadence for display. */
  readonly cadence: "trial" | "month" | "year" | "paused";
}

/**
 * The price book. Amounts are illustrative marketing prices per currency;
 * Trial and Shield_Paused are always zero-cost states shown for completeness
 * (R30.3). Amounts are localized for display via {@link formatPrice}.
 */
export const PRICE_BOOK: Readonly<Record<Currency, Readonly<Record<PlanId, PlanPrice>>>> = {
  INR: {
    trial: { amount: 0, cadence: "trial" },
    pro_monthly: { amount: 299, cadence: "month" },
    pro_annual: { amount: 2999, cadence: "year" },
    shield_paused: { amount: 0, cadence: "paused" },
  },
  USD: {
    trial: { amount: 0, cadence: "trial" },
    pro_monthly: { amount: 5, cadence: "month" },
    pro_annual: { amount: 49, cadence: "year" },
    shield_paused: { amount: 0, cadence: "paused" },
  },
  GBP: {
    trial: { amount: 0, cadence: "trial" },
    pro_monthly: { amount: 4, cadence: "month" },
    pro_annual: { amount: 39, cadence: "year" },
    shield_paused: { amount: 0, cadence: "paused" },
  },
  AED: {
    trial: { amount: 0, cadence: "trial" },
    pro_monthly: { amount: 19, cadence: "month" },
    pro_annual: { amount: 189, cadence: "year" },
    shield_paused: { amount: 0, cadence: "paused" },
  },
  SGD: {
    trial: { amount: 0, cadence: "trial" },
    pro_monthly: { amount: 7, cadence: "month" },
    pro_annual: { amount: 69, cadence: "year" },
    shield_paused: { amount: 0, cadence: "paused" },
  },
};

/** Returns the price for a plan in the given currency. */
export function getPlanPrice(currency: Currency, plan: PlanId): PlanPrice {
  return PRICE_BOOK[currency][plan];
}

/**
 * Formats an amount as a localized currency string (e.g. `₹299`, `$5`). Uses
 * `Intl.NumberFormat` with no fractional digits since the price book uses whole
 * units. Falls back to a symbol-prefixed string if `Intl` is unavailable.
 */
export function formatPrice(currency: Currency, amount: number): string {
  const meta = CURRENCY_META[currency];
  try {
    return new Intl.NumberFormat(meta.numberLocale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${meta.symbol}${amount}`;
  }
}
