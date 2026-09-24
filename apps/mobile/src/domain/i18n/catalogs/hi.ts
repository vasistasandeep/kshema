/**
 * Hindi (hi) locale catalog (R17.1).
 *
 * Preserves Brand_Lexicon meaning and excludes Banned_Terms and their Hindi
 * equivalents (R17.4). Brand nouns (Kshema, Anchor, Observer, Circle) are kept
 * as transliterations so the dignified lexicon carries across languages.
 */
import type { Catalog } from "../keys.js";

export const hi: Catalog = {
  "brand.appName": "क्षेमा",
  "brand.tagline": "अपने प्रियजनों के लिए शांत सुरक्षा",

  "role.anchor": "एंकर",
  "role.observer": "ऑब्ज़र्वर",
  "role.circle": "सर्कल",

  "onboarding.welcome.title": "क्षेमा में आपका स्वागत है",
  "onboarding.welcome.subtitle": "आपके सर्कल के लिए सौम्य, गरिमापूर्ण सुरक्षा",
  "onboarding.verify.title": "अपना नंबर सत्यापित करें",
  "onboarding.preferredName.prompt": "आपका सर्कल आपको किस नाम से बुलाए?",
  "onboarding.joinCircle.title": "अपने सर्कल में शामिल हों",
  "onboarding.continue": "आगे बढ़ें",

  "dashboard.title": "आपका सर्कल",
  "wellbeing.allWell": "सब ठीक है",
  "wellbeing.checkingIn": "हाल जान रहे हैं",
  "wellbeing.needsAttention": "एक सौम्य जाँच की ज़रूरत है",
  "vitality.pulseGreeting": "सुप्रभात — आपका सर्कल आपको याद कर रहा है",
  "vitality.lastConfirmed": "पिछली बार कुशल की पुष्टि",

  "distress.reassurance": "मदद आ रही है। आप अकेले नहीं हैं।",
  "distress.observerAlerted": "आपके ऑब्ज़र्वर को चुपचाप सूचित कर दिया गया है",
  "sos.silentSent": "आपके सर्कल को एक मौन सूचना भेजी गई",

  "subscription.trialCountdown": "आपके ट्रायल में शेष दिन",
  "subscription.upgradePrompt": "अपने सर्कल के लिए पूर्ण सुरक्षा बनाए रखें",
  "subscription.shieldPaused": "सुरक्षा रोक दी गई है",

  "settings.language.title": "भाषा",
  "language.en": "अंग्रेज़ी",
  "language.hi": "हिन्दी",
  "language.kn": "कन्नड़",
  "language.ta": "तमिल",
  "language.te": "तेलुगु",

  "disclaimer.title": "क्षेमा कैसे मदद करता है, इस पर एक नोट",
  "disclaimer.body":
    "क्षेमा आश्वासन देता है और आपके सर्कल तक पहुँचने का एक तरीका देता है। यह आपातकालीन सेवा नहीं है और स्थानीय मदद बुलाने का विकल्प नहीं है।",
  "disclaimer.accept": "मैं समझता/समझती हूँ",
};
