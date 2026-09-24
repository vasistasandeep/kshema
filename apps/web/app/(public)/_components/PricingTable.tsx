import type { Translator } from "../../../content/catalog";
import {
  type Currency,
  CURRENCY_META,
  SUPPORTED_CURRENCIES,
  formatPrice,
  getPlanPrice,
  type PlanId,
} from "../../../lib/pricing";

/**
 * Localized pricing presentation (R30.3, R30.4).
 *
 * Shows the four subscription states — 14-day Trial, monthly Pro, annual Pro,
 * and Shield Paused — priced in the visitor's detected currency, with a manual
 * currency override rendered as plain anchor links (each targets the same page
 * with a `?currency=` param, so the grid stays static/SSG). Free states show
 * their localized label rather than a zero amount.
 *
 * Requirements: 30.3, 30.4, 30.8.
 */

const PLAN_ORDER: readonly PlanId[] = [
  "trial",
  "pro_monthly",
  "pro_annual",
  "shield_paused",
];

const PLAN_NAME_KEY = {
  trial: "pricing.plan.trial.name",
  pro_monthly: "pricing.plan.pro_monthly.name",
  pro_annual: "pricing.plan.pro_annual.name",
  shield_paused: "pricing.plan.shield_paused.name",
} as const;

const PLAN_DESC_KEY = {
  trial: "pricing.plan.trial.desc",
  pro_monthly: "pricing.plan.pro_monthly.desc",
  pro_annual: "pricing.plan.pro_annual.desc",
  shield_paused: "pricing.plan.shield_paused.desc",
} as const;

function priceLabel(t: Translator, currency: Currency, plan: PlanId): string {
  const { amount, cadence } = getPlanPrice(currency, plan);
  if (plan === "trial") return t("pricing.plan.trial.price");
  if (plan === "shield_paused") return t("pricing.plan.shield_paused.price");
  const cadenceLabel =
    cadence === "month" ? t("pricing.cadence.month") : t("pricing.cadence.year");
  return `${formatPrice(currency, amount)} ${cadenceLabel}`;
}

export function PricingTable({
  t,
  currency,
  currencyHrefBase,
}: {
  t: Translator;
  currency: Currency;
  /** Base path used to build the manual currency-override links. */
  currencyHrefBase: string;
}): JSX.Element {
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="text-sm text-typography/70">
          {t("pricing.currencyLabel")}:
        </span>
        <ul className="flex flex-wrap gap-2">
          {SUPPORTED_CURRENCIES.map((c) => {
            const active = c === currency;
            return (
              <li key={c}>
                <a
                  href={`${currencyHrefBase}?currency=${c}`}
                  aria-current={active ? "true" : undefined}
                  className={`inline-flex items-center rounded-full px-3 py-1 text-sm ${
                    active
                      ? "bg-primary-action text-white"
                      : "bg-white/70 text-typography/80"
                  }`}
                >
                  {CURRENCY_META[c].symbol} {c}
                </a>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLAN_ORDER.map((plan) => (
          <article
            key={plan}
            className="flex flex-col rounded-2xl bg-white/70 p-5 shadow-sm"
          >
            <h3 className="text-lg font-semibold text-typography">
              {t(PLAN_NAME_KEY[plan])}
            </h3>
            <p className="mt-2 text-2xl font-semibold text-primary-action">
              {priceLabel(t, currency, plan)}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-typography/75">
              {t(PLAN_DESC_KEY[plan])}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
