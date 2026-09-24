/**
 * English (canonical) i18n catalog for the public brand & trust portal.
 *
 * This catalog defines the authoritative key set; every other Supported_
 * Language catalog is typed as `Record<CatalogKey, string>` so a missing key
 * fails typecheck (keeping all five languages in lockstep — R30.5, R17.2).
 *
 * All strings are drawn from the Brand_Lexicon and MUST exclude every
 * Banned_Term (R30.8, Property 14); this is asserted by the catalog tests and
 * the `no-banned-terms` lint.
 *
 * Requirements: 30.1, 30.2, 30.3, 30.5, 30.6, 30.7, 30.8.
 */
export const catalogEn = {
  // Navigation / shell
  "nav.philosophy": "Our Philosophy",
  "nav.howItWorks": "How It Works",
  "nav.pricing": "Plans",
  "nav.legal": "Trust & Legal",
  "brand.name": "Kshema",
  "brand.tagline": "Ambient care for the people you love.",

  // Philosophy — Dignity Over Surveillance (R30.1)
  "philosophy.heading": "Dignity Over Surveillance",
  "philosophy.lede":
    "Everyday life should stay private. Kshema infers well-being from quiet, passive signals your phone already produces, so there are no cameras, no location trails, and no buttons to remember.",
  "philosophy.ambient.title": "Ambient by design",
  "philosophy.ambient.body":
    "A missed morning routine or an unusual quiet is inferred gently from passive rhythm, never from watching where you go.",
  "philosophy.private.title": "Private by default",
  "philosophy.private.body":
    "Your circle sees whether all is well — never a trail of your movements. Sensitive snapshots are sealed so only your chosen circle can ever open them.",
  "philosophy.dignified.title": "Dignified escalation",
  "philosophy.dignified.body":
    "When something seems off, a warm check-in comes first. Help only reaches further if a gentle reply does not.",

  // Escalation ladder (R30.2)
  "howItWorks.heading": "How care unfolds, one gentle step at a time",
  "escalation.stage1.title": "A warm check-in",
  "escalation.stage1.desc":
    "A friendly conversational message asks if all is well. A single reply settles everything.",
  "escalation.stage2.title": "A soft nudge on the device",
  "escalation.stage2.desc":
    "If there is no reply, the phone offers a gentle chime and your circle receives a quiet heads-up.",
  "escalation.stage3.title": "Your circle is invited in",
  "escalation.stage3.desc":
    "Your chosen circle is asked to reach out directly, using the ways you have already approved.",
  "escalation.stage4.title": "Nearby help is guided to the door",
  "escalation.stage4.desc":
    "As a last step, trusted nearby contacts receive the address details needed to reach you quickly.",

  // Flight Recorder explainer (R30.2)
  "flightRecorder.heading": "The zero-knowledge Flight Recorder",
  "flightRecorder.point.snapshots":
    "The app keeps a short rolling set of recent context snapshots, and always discards the oldest.",
  "flightRecorder.point.encrypted":
    "Each snapshot is sealed on your device with keys only your circle holds.",
  "flightRecorder.point.serverBlind":
    "Our servers store the sealed data but can never open it — the platform is blind to the contents.",
  "flightRecorder.point.release":
    "Sealed context is only ever opened by an authorized circle member during a confirmed emergency.",

  // Pricing (R30.3)
  "pricing.heading": "Simple plans for continuous peace of mind",
  "pricing.subhead": "Prices shown in your local currency.",
  "pricing.currencyLabel": "Currency",
  "pricing.plan.trial.name": "14-Day Trial",
  "pricing.plan.trial.desc":
    "Full protection for fourteen days so your family can feel the difference.",
  "pricing.plan.trial.price": "Free",
  "pricing.plan.pro_monthly.name": "Pro — Monthly",
  "pricing.plan.pro_monthly.desc": "The complete ambient shield, billed each month.",
  "pricing.plan.pro_annual.name": "Pro — Annual",
  "pricing.plan.pro_annual.desc": "The complete ambient shield, billed yearly for the best value.",
  "pricing.plan.shield_paused.name": "Shield Paused",
  "pricing.plan.shield_paused.desc":
    "Keep your account with the shield resting when you no longer need active cover.",
  "pricing.plan.shield_paused.price": "No charge",
  "pricing.cadence.month": "per month",
  "pricing.cadence.year": "per year",

  // Legal (R30.6, R30.7)
  "legal.heading": "Trust, safety, and your data",
  "legal.terms.title": "Terms of Service",
  "legal.terms.body":
    "These terms describe how Kshema provides an ambient well-being service, the responsibilities of each circle member, and the limits of the service. By creating a circle you agree to use Kshema as a supportive companion rather than a guaranteed emergency service.",
  "legal.disclaimer.title": "Safety Disclaimer",
  "legal.disclaimer.body":
    "Kshema is a supportive well-being companion, not a substitute for emergency services. Always contact your local emergency number in a genuine crisis. Delivery of check-ins and alerts depends on device power, connectivity, and carrier availability, which we cannot guarantee.",
  "legal.privacy.title": "Privacy Policy (DPDP & GDPR)",
  "legal.privacy.body":
    "This policy explains what we collect, why, and your rights under India's DPDP Act and the EU GDPR — including access, correction, erasure, portability, and withdrawal of consent. We process the minimum data needed to provide the service and never use it for advertising.",
  "legal.dataSafety.title": "Data Safety Disclosure",
  "legal.dataSafety.body":
    "We collect device identifiers, notification tokens, and step-delta diagnostics to infer daily rhythm. We do not store a continuous location trail on our servers, and sensitive context is sealed with keys only your circle holds.",
  "legal.dataSafety.neverSold": "Your data is never sold or traded to anyone, for any reason.",

  // Footer
  "footer.rights": "Made with care for families everywhere.",
  "footer.language": "Language",
} as const;

/** The canonical set of i18n keys the portal renders. */
export type CatalogKey = keyof typeof catalogEn;

/** A fully-populated catalog for one Supported_Language. */
export type Catalog = Readonly<Record<CatalogKey, string>>;
