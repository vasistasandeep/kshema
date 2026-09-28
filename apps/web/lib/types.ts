/**
 * Web-app view models. These mirror the platform DTOs (packages/types) but are
 * shaped for the UI. The data layer (lib/data) returns these whether the source
 * is the live API or the in-memory mock, so components never branch on source.
 */

export type WellbeingState = "ALL_WELL" | "ESCALATING" | "SHIELD_PAUSED" | "SANCTUARY";

export type IncidentStage =
  | "STAGE_1_CONVERSATIONAL_WHATSAPP"
  | "STAGE_2_GENTLE_DEVICE_CHIME"
  | "STAGE_3_OBSERVER_SILENT_ALERT"
  | "STAGE_4_HYPERLOCAL_DISPATCH";

export type PersonaMode =
  | "ELDERLY_CARE"
  | "SOLO_LIVING"
  | "ACTIVE_SESSION"
  | "JOURNEY_WATCH"
  | "POST_OP_RECOVERY";

export type CircleRole = "ANCHOR" | "OBSERVER" | "MUTUAL";
export type SubscriptionTier = "TRIAL" | "PRO" | "SHIELD_PAUSED";
export type SparshType =
  | "MORNING_CHAI"
  | "PRANAM_BLESSING"
  | "MORNING_SUN"
  | "MARIGOLD_FLOWER"
  | "HEART_BLESSING";

export interface Anchor {
  id: string;
  preferredName: string;
  timezone: string;
  wellbeing: WellbeingState;
  personaModes: PersonaMode[];
  lastConfirmationAt: string | null;
  graceDeadline: string | null;
  stepCount: number;
  batteryPercent: number;
  charging: boolean;
  weather?: { tempC: number; summary: string };
  vitalityStreak: number;
  activeIncident?: SafetyIncident | null;
  avatarHue: number;
}

export interface SafetyIncident {
  id: string;
  anchorId: string;
  stage: IncidentStage;
  status: "OPEN" | "RESOLVED" | "HANDED_OFF_SOS";
  openedAt: string;
  audit: { stage: string; at: string; cause: string }[];
}

export interface VitalityDay {
  date: string;
  confirmed: boolean;
  confirmationTime: string | null;
  steps: number;
  sparsh: SparshType[];
}

export interface CircleMember {
  id: string;
  name: string;
  role: CircleRole;
  canTriggerIVR: boolean;
  canAccessBlackBox: boolean;
  online: boolean;
}

export interface SentinelPolicy {
  anchorId: string;
  personaModes: PersonaMode[];
  expectedWake: string;
  expectedBed: string;
  graceMinutes: number;
  language: string;
  whatsappSchedule: string;
}

export interface HyperlocalProfile {
  society: string;
  block: string;
  flat: string;
  gateContact: string;
  neighborContact: string;
  smartLockCode: string;
  doorAccessNotes: string;
}

export interface Subscription {
  tier: SubscriptionTier;
  trialEndsAt: string | null;
  interval: "MONTHLY" | "ANNUAL";
  amount: number;
  currency: string;
  renewsAt: string | null;
}

export interface Invoice {
  id: string;
  date: string;
  amount: number;
  currency: string;
  status: "PAID" | "PENDING" | "FAILED";
}

export interface PanchangaCard {
  sunrise: string;
  sunset: string;
  tithi: string;
  nakshatra: string;
  masa: string;
  festival: string | null;
  proverb: string;
}

export interface Circle {
  id: string;
  name: string;
  subscription: Subscription;
  members: CircleMember[];
}

export interface DashboardSummary {
  circle: Circle;
  anchors: Anchor[];
  observerTimezone: string;
}
