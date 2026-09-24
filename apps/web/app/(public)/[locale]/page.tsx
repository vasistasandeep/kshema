import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslator } from "../../../content/catalog";
import { isLocale, LOCALE_META, type Locale } from "../../../content/locales";
import { EscalationLadder } from "../_components/EscalationLadder";
import { FlightRecorderExplainer } from "../_components/FlightRecorderExplainer";

/**
 * Public portal home (SSG) — the "Dignity Over Surveillance" philosophy (R30.1),
 * the interactive four-stage escalation ladder, and the zero-knowledge
 * Flight_Recorder explainer (R30.2). Statically generated per Supported_Language.
 *
 * Requirements: 30.1, 30.2, 30.5, 30.8.
 */
export function generateMetadata({
  params,
}: {
  params: { locale: string };
}): Metadata {
  const locale: Locale = isLocale(params.locale) ? params.locale : "en";
  const t = getTranslator(locale);
  return {
    title: `${t("brand.name")} — ${t("philosophy.heading")}`,
    description: t("philosophy.lede"),
    alternates: {
      languages: Object.fromEntries(
        Object.values(LOCALE_META).map((m) => [m.code, `/${m.code}`]),
      ),
    },
  };
}

export default function PublicHome({
  params,
}: {
  params: { locale: string };
}): JSX.Element {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);

  return (
    <div className="space-y-16">
      {/* Philosophy — Dignity Over Surveillance (R30.1) */}
      <section aria-labelledby="philosophy-heading">
        <p className="text-sm font-medium uppercase tracking-wide text-primary-action">
          {t("brand.tagline")}
        </p>
        <h1
          id="philosophy-heading"
          className="mt-3 text-4xl font-semibold text-typography sm:text-5xl"
        >
          {t("philosophy.heading")}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-typography/80">
          {t("philosophy.lede")}
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {(
            [
              ["philosophy.ambient.title", "philosophy.ambient.body"],
              ["philosophy.private.title", "philosophy.private.body"],
              ["philosophy.dignified.title", "philosophy.dignified.body"],
            ] as const
          ).map(([titleKey, bodyKey]) => (
            <article
              key={titleKey}
              className="rounded-2xl bg-white/70 p-5 shadow-sm"
            >
              <h2 className="font-semibold text-typography">{t(titleKey)}</h2>
              <p className="mt-2 text-sm leading-relaxed text-typography/75">
                {t(bodyKey)}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Interactive escalation ladder (R30.2) */}
      <section id="how-it-works" aria-labelledby="how-heading" className="scroll-mt-24">
        <h2
          id="how-heading"
          className="text-2xl font-semibold text-typography sm:text-3xl"
        >
          {t("howItWorks.heading")}
        </h2>
        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <EscalationLadder t={t} />
          <FlightRecorderExplainer t={t} />
        </div>
      </section>

      {/* Pricing teaser → full pricing page */}
      <section aria-labelledby="pricing-cta-heading">
        <div className="rounded-2xl bg-primary-action/10 p-8 text-center">
          <h2
            id="pricing-cta-heading"
            className="text-2xl font-semibold text-typography"
          >
            {t("pricing.heading")}
          </h2>
          <p className="mt-3 text-typography/75">{t("pricing.subhead")}</p>
          <Link
            href={`/${locale}/pricing`}
            className="mt-6 inline-flex rounded-full bg-primary-action px-6 py-3 font-medium text-white"
          >
            {t("nav.pricing")}
          </Link>
        </div>
      </section>
    </div>
  );
}
