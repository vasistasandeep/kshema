import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getTranslator } from "../../../content/catalog";
import {
  SUPPORTED_LOCALES,
  isLocale,
  type Locale,
} from "../../../content/locales";
import { LanguageSwitch } from "../_components/LanguageSwitch";

/**
 * Layout shell for the localized public brand & trust portal (R30).
 *
 * Provides the header nav, the five-language switcher, and the footer, all
 * rendered from the active locale's catalog. Every locale under
 * {@link SUPPORTED_LOCALES} is statically generated (SSG) via
 * `generateStaticParams`; an unknown locale segment 404s.
 *
 * Requirements: 30.5, 30.8.
 */

/** Pre-render one static path per Supported_Language (SSG). */
export function generateStaticParams(): { locale: Locale }[] {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

/** Statically generate; no per-request dynamic behavior in the shell. */
export const dynamicParams = false;

export default function PublicLocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { locale: string };
}): JSX.Element {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);
  const base = `/${locale}`;

  const navItems: { href: string; key: Parameters<typeof t>[0] }[] = [
    { href: `${base}`, key: "nav.philosophy" },
    { href: `${base}#how-it-works`, key: "nav.howItWorks" },
    { href: `${base}/pricing`, key: "nav.pricing" },
    { href: `${base}/legal`, key: "nav.legal" },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="border-b border-deep-charcoal/10 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href={base} className="text-xl font-semibold text-typography">
            {t("brand.name")}
          </Link>
          <nav aria-label={t("brand.name")} className="flex flex-wrap gap-4">
            {navItems.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="text-sm text-typography/80 hover:text-primary-action"
              >
                {t(item.key)}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {children}
      </main>

      <footer className="border-t border-deep-charcoal/10 bg-canvas">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-typography/60">{t("footer.rights")}</p>
          <LanguageSwitch
            current={locale}
            label={t("footer.language")}
            hrefFor={(loc) => `/${loc}`}
          />
        </div>
      </footer>
    </div>
  );
}
