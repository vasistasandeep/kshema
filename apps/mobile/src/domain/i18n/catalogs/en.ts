/**
 * English (en) locale catalog — the reference catalog (R17.1).
 *
 * Every string is drawn from the Brand_Lexicon and excludes every Banned_Term
 * (R16.1, R17.4). Anchors and Observers are named as such rather than as
 * patients/guardians, and safety language is reassuring rather than clinical.
 */
import type { Catalog } from "../keys.js";

export const en: Catalog = {
  "brand.appName": "Kshema",
  "brand.tagline": "Quiet protection for the people you love",

  "role.anchor": "Anchor",
  "role.observer": "Observer",
  "role.circle": "Circle",

  "onboarding.welcome.title": "Welcome to Kshema",
  "onboarding.welcome.subtitle": "Gentle, dignified safety for your Circle",
  "onboarding.verify.title": "Verify your number",
  "onboarding.preferredName.prompt": "What should your Circle call you?",
  "onboarding.joinCircle.title": "Join your Circle",
  "onboarding.continue": "Continue",

  "dashboard.title": "Your Circle",
  "wellbeing.allWell": "All well",
  "wellbeing.checkingIn": "Checking in",
  "wellbeing.needsAttention": "Needs a gentle check",
  "vitality.pulseGreeting": "Good morning — your Circle is thinking of you",
  "vitality.lastConfirmed": "Last confirmed well",

  "distress.reassurance": "Help is on the way. You are not alone.",
  "distress.observerAlerted": "Your Observers have been quietly notified",
  "sos.silentSent": "A silent alert was sent to your Circle",

  "subscription.trialCountdown": "Days left in your trial",
  "subscription.upgradePrompt": "Keep full protection for your Circle",
  "subscription.shieldPaused": "Protection is paused",

  "settings.language.title": "Language",
  "language.en": "English",
  "language.hi": "Hindi",
  "language.kn": "Kannada",
  "language.ta": "Tamil",
  "language.te": "Telugu",

  "disclaimer.title": "A note on how Kshema helps",
  "disclaimer.body":
    "Kshema offers reassurance and a way to reach your Circle. It is not an emergency service and does not replace calling local help.",
  "disclaimer.accept": "I understand",
};
