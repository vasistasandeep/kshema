/**
 * i18n message-key contract (R17.1, R17.2).
 *
 * `MESSAGE_KEYS` is the single source of truth for every user-facing string
 * the app renders. Each Supported_Language catalog must supply a value for
 * every key (enforced by the catalog type and the runtime tests), so selecting
 * a language re-renders all text with a complete translation (R17.2) and no
 * key silently falls back to English.
 *
 * Keys are grouped by surface (brand terms, onboarding, dashboard, well-being
 * states, distress, subscription, language picker, disclaimer) and reflect the
 * Brand_Lexicon (Anchor / Observer / Circle rather than any Banned_Term).
 */

export const MESSAGE_KEYS = [
  // Brand_Lexicon core nouns (R16.5) — dignified, non-clinical vocabulary.
  "brand.appName",
  "brand.tagline",
  "role.anchor",
  "role.observer",
  "role.circle",

  // Onboarding funnel.
  "onboarding.welcome.title",
  "onboarding.welcome.subtitle",
  "onboarding.verify.title",
  "onboarding.preferredName.prompt",
  "onboarding.joinCircle.title",
  "onboarding.continue",

  // Dashboard / well-being (R15.4).
  "dashboard.title",
  "wellbeing.allWell",
  "wellbeing.checkingIn",
  "wellbeing.needsAttention",
  "vitality.pulseGreeting",
  "vitality.lastConfirmed",

  // Distress & reassurance (non-alarming lexicon).
  "distress.reassurance",
  "distress.observerAlerted",
  "sos.silentSent",

  // Subscription (R20).
  "subscription.trialCountdown",
  "subscription.upgradePrompt",
  "subscription.shieldPaused",

  // Language selection surface (R17.2).
  "settings.language.title",
  "language.en",
  "language.hi",
  "language.kn",
  "language.ta",
  "language.te",

  // Safety disclaimer (R26.4).
  "disclaimer.title",
  "disclaimer.body",
  "disclaimer.accept",
] as const;

/** A single user-facing message key. */
export type MessageKey = (typeof MESSAGE_KEYS)[number];

/**
 * A complete catalog: every `MessageKey` mapped to a non-empty translated
 * string. The `Record<MessageKey, string>` shape makes an omitted key a
 * compile-time error, guaranteeing full coverage per locale.
 */
export type Catalog = Record<MessageKey, string>;
