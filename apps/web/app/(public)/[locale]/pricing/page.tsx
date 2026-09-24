import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslator } from "../../../../content/catalog";
import { isLocale, type Locale } from "../../../../content/locales";
import { detectCurrency } from "../../../../lib/pricing";
import { PricingTable } from "../../_components/PricingTable";

/**
 * Localized pricing page (R30.3, R30.4).
 *
 * The four subscription states (14-day Trial, monthly Pro, annual Pro, Shield
 * Paused) are priced in the visitor's currency. Currency is resolved by
 * {@link detectCurrency}: a manual `?currency=` override wins, otherwise the
 * edge geo country header (set by middleware into the `x-geo-country` request
 * header / query) maps to a presentment currency, falling back to USD.
 *
 * The page is statically generated per Supported_Language; the currency
 * override is a query param so the grid stays static and cacheable.
 *
 * Requirements: 30.3, 30.4, 30.5, 30.8.
 */
export function generateMetadata({
  params,
}: {
  params: { locale: string };
}): Metadata {
  const locale: Locale = isLocale(params.locale) ? params.locale : "en";
  const t = getTranslator(locale);
  return { title: `${t("brand.name")} — ${t("pricing.heading")}` };
}

export default function PricingPage({
  params,
  searchParams,
}: {
  params: { locale: string };
  searchParams: { currency?: string; country?: string };
}): JSX.Element {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);

  // Manual override (?currency=) wins; otherwise the geo country hint maps to a
  // currency; otherwise USD. The country hint is supplied by edge middleware.
  const currency = detectCurrency(searchParams.country, searchParams.currency);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold text-typography sm:text-4xl">
          {t("pricing.heading")}
        </h1>
        <p className="mt-3 text-typography/75">{t("pricing.subhead")}</p>
      </header>

      <PricingTable
        t={t}
        currency={currency}
        currencyHrefBase={`/${locale}/pricing`}
      />
    </div>
  );
}
