import type {
  Anchor, Circle, DashboardSummary, VitalityDay, SentinelPolicy,
  HyperlocalProfile, Invoice, PanchangaCard, SafetyIncident,
} from "../types";

const now = () => new Date();
const iso = (d: Date) => d.toISOString();
const minsAgo = (m: number) => iso(new Date(Date.now() - m * 60000));
const hoursFromNow = (h: number) => iso(new Date(Date.now() + h * 3600000));
const daysFromNow = (d: number) => iso(new Date(Date.now() + d * 86400000));

export const anchors: Anchor[] = [
  {
    id: "anc_lakshmi",
    preferredName: "Lakshmi Amma",
    timezone: "Asia/Kolkata",
    wellbeing: "ALL_WELL",
    personaModes: ["ELDERLY_CARE"],
    lastConfirmationAt: minsAgo(42),
    graceDeadline: null,
    stepCount: 1840,
    batteryPercent: 82,
    charging: false,
    weather: { tempC: 29, summary: "Sunny" },
    vitalityStreak: 23,
    activeIncident: null,
    avatarHue: 145,
  },
  {
    id: "anc_raghav",
    preferredName: "Raghav",
    timezone: "Asia/Kolkata",
    wellbeing: "ESCALATING",
    personaModes: ["SOLO_LIVING", "POST_OP_RECOVERY"],
    lastConfirmationAt: minsAgo(190),
    graceDeadline: minsAgo(35),
    stepCount: 120,
    batteryPercent: 41,
    charging: false,
    weather: { tempC: 26, summary: "Cloudy" },
    vitalityStreak: 8,
    avatarHue: 28,
    activeIncident: {
      id: "inc_1",
      anchorId: "anc_raghav",
      stage: "STAGE_2_GENTLE_DEVICE_CHIME",
      status: "OPEN",
      openedAt: minsAgo(35),
      audit: [
        { stage: "STAGE_1_CONVERSATIONAL_WHATSAPP", at: minsAgo(35), cause: "Grace deadline passed" },
        { stage: "STAGE_2_GENTLE_DEVICE_CHIME", at: minsAgo(15), cause: "No response in 20m" },
      ],
    },
  },
  {
    id: "anc_meera",
    preferredName: "Meera",
    timezone: "America/New_York",
    wellbeing: "ALL_WELL",
    personaModes: ["JOURNEY_WATCH"],
    lastConfirmationAt: minsAgo(12),
    graceDeadline: null,
    stepCount: 6420,
    batteryPercent: 67,
    charging: true,
    weather: { tempC: 14, summary: "Rain" },
    vitalityStreak: 51,
    activeIncident: null,
    avatarHue: 200,
  },
  {
    id: "anc_thomas",
    preferredName: "Thomas",
    timezone: "Asia/Kolkata",
    wellbeing: "SHIELD_PAUSED",
    personaModes: ["ELDERLY_CARE"],
    lastConfirmationAt: minsAgo(1440),
    graceDeadline: null,
    stepCount: 0,
    batteryPercent: 55,
    charging: false,
    vitalityStreak: 0,
    activeIncident: null,
    avatarHue: 275,
  },
];

export const circle: Circle = {
  id: "circle_home",
  name: "Home Circle",
  subscription: {
    tier: "TRIAL",
    trialEndsAt: daysFromNow(9),
    interval: "MONTHLY",
    amount: 499,
    currency: "INR",
    renewsAt: null,
  },
  members: [
    { id: "m1", name: "You (Priya)", role: "OBSERVER", canTriggerIVR: true, canAccessBlackBox: true, online: true },
    { id: "m2", name: "Lakshmi Amma", role: "ANCHOR", canTriggerIVR: false, canAccessBlackBox: false, online: true },
    { id: "m3", name: "Raghav", role: "MUTUAL", canTriggerIVR: true, canAccessBlackBox: true, online: false },
    { id: "m4", name: "Arjun", role: "OBSERVER", canTriggerIVR: false, canAccessBlackBox: false, online: true },
  ],
};

export const dashboardSummary: DashboardSummary = {
  circle,
  anchors,
  observerTimezone: "Asia/Kolkata",
};

export function vitalityHistory(anchorId: string): VitalityDay[] {
  const days: VitalityDay[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const confirmed = !(i === 3 || i === 11);
    const h = 6 + Math.floor(Math.random() * 2);
    const mm = Math.floor(Math.random() * 59);
    days.push({
      date: d.toISOString().slice(0, 10),
      confirmed,
      confirmationTime: confirmed ? `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}` : null,
      steps: confirmed ? 1200 + Math.floor(Math.random() * 5000) : 0,
      sparsh: i % 3 === 0 ? ["MORNING_CHAI"] : i % 5 === 0 ? ["MARIGOLD_FLOWER", "HEART_BLESSING"] : [],
    });
  }
  return days;
}

export const sentinelPolicy: SentinelPolicy = {
  anchorId: "anc_lakshmi",
  personaModes: ["ELDERLY_CARE"],
  expectedWake: "06:30",
  expectedBed: "21:30",
  graceMinutes: 90,
  language: "en",
  whatsappSchedule: "07:00",
};

export const hyperlocalProfile: HyperlocalProfile = {
  society: "Green Meadows",
  block: "B",
  flat: "402",
  gateContact: "+91 98??? ??210",
  neighborContact: "+91 99??? ??887",
  smartLockCode: "????",
  doorAccessNotes: "Spare key with gate security. Lift to 4th floor, turn left.",
};

export const invoices: Invoice[] = [
  { id: "inv_003", date: "2024-05-01", amount: 499, currency: "INR", status: "PAID" },
  { id: "inv_002", date: "2024-04-01", amount: 499, currency: "INR", status: "PAID" },
  { id: "inv_001", date: "2024-03-01", amount: 499, currency: "INR", status: "PAID" },
];

export const panchanga: PanchangaCard = {
  sunrise: "06:04",
  sunset: "18:42",
  tithi: "Shukla Panchami",
  nakshatra: "Rohini",
  masa: "Vaishakha",
  festival: "Akshaya Tritiya (in 2 days)",
  proverb: "A calm mind brings inner strength and self-confidence.",
};

export function findAnchor(id: string): Anchor | undefined {
  return anchors.find((a) => a.id === id);
}
