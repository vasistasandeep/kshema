import Link from "next/link";
import { LOCALE_META, SUPPORTED_LOCALES, type Locale } from "../../../content/locales";

/**
 * Five-language switcher (R30.5). Each language is a plain link to the same
 * page under a different locale segment, so switching re-renders every string
 * from that locale's catalog with no client JavaScript. Endonyms label each
 * option so speakers recognize their own language.
 *
 * Requirements: 30.5, 17.2.
 */
export function LanguageSwitch({
  current,
  hrefFor,
  label,
}: {
  current: Locale;
  /** Builds the destination path for a given locale on the current page. */
  hrefFor: (locale: Locale) => string;
  /** Localized "Language" label. */
  label: string;
}): JSX.Element {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-wide text-typography/50">
        {label}
      </span>
      <ul className="flex flex-wrap gap-1">
        {SUPPORTED_LOCALES.map((loc) => {
          const active = loc === current;
          return (
            <li key={loc}>
              <Link
                href={hrefFor(loc)}
                hrefLang={loc}
                aria-current={active ? "true" : undefined}
                className={`inline-flex rounded-full px-3 py-1 text-sm ${
                  active
                    ? "bg-deep-charcoal text-white"
                    : "text-typography/80 hover:bg-white/70"
                }`}
              >
                {LOCALE_META[loc].nativeName}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
