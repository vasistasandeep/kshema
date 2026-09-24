import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslator } from "../../../../content/catalog";
import { isLocale, type Locale } from "../../../../content/locales";
import type { CatalogKey } from "../../../../content/catalog";

/**
 * Legal & trust page (SSG) hosting the Terms of Service, the mandatory
 * Safety_Disclaimer, the DPDP-/GDPR-compliant Privacy Policy, and the public
 * Data_Safety_Disclosure — the latter affirming that data is never sold or
 * traded (R30.6, R30.7). Statically generated per Supported_Language.
 *
 * Requirements: 30.5, 30.6, 30.7, 30.8.
 */
export function generateMetadata({
  params,
}: {
  params: { locale: string };
}): Metadata {
  const locale: Locale = isLocale(params.locale) ? params.locale : "en";
  const t = getTranslator(locale);
  return { title: `${t("brand.name")} — ${t("legal.heading")}` };
}

const SECTIONS: {
  id: string;
  titleKey: CatalogKey;
  bodyKey: CatalogKey;
  extraKey?: CatalogKey;
}[] = [
  { id: "terms", titleKey: "legal.terms.title", bodyKey: "legal.terms.body" },
  {
    id: "safety-disclaimer",
    titleKey: "legal.disclaimer.title",
    bodyKey: "legal.disclaimer.body",
  },
  {
    id: "privacy",
    titleKey: "legal.privacy.title",
    bodyKey: "legal.privacy.body",
  },
  {
    id: "data-safety",
    titleKey: "legal.dataSafety.title",
    bodyKey: "legal.dataSafety.body",
    extraKey: "legal.dataSafety.neverSold",
  },
];

export default function LegalPage({
  params,
}: {
  params: { locale: string };
}): JSX.Element {
  if (!isLocale(params.locale)) notFound();
  const t = getTranslator(params.locale);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold text-typography sm:text-4xl">
          {t("legal.heading")}
        </h1>
      </header>

      {/* Section index for quick navigation */}
      <nav aria-label={t("legal.heading")} className="flex flex-wrap gap-3">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full bg-white/70 px-3 py-1 text-sm text-typography/80 hover:text-primary-action"
          >
            {t(s.titleKey)}
          </a>
        ))}
      </nav>

      {SECTIONS.map((s) => (
        <section
          key={s.id}
          id={s.id}
          aria-labelledby={`${s.id}-title`}
          className="scroll-mt-24 rounded-2xl bg-white/60 p-6"
        >
          <h2
            id={`${s.id}-title`}
            className="text-xl font-semibold text-typography"
          >
            {t(s.titleKey)}
          </h2>
          <p className="mt-3 leading-relaxed text-typography/80">
            {t(s.bodyKey)}
          </p>
          {s.extraKey ? (
            <p className="mt-3 font-medium text-primary-action">
              {t(s.extraKey)}
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
