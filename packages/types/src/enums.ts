/**
 * @kshema/types — shared enum schemas.
 *
 * These mirror the Prisma enums in `packages/database/prisma/schema.prisma`
 * so request/response DTOs validate against one canonical set of values.
 * Keep these in lock-step with the Prisma schema.
 */
import { z } from "zod";

export const CircleRoleSchema = z.enum(["ANCHOR", "OBSERVER", "MUTUAL"]);
export type CircleRole = z.infer<typeof CircleRoleSchema>;

export const SentinelModeSchema = z.enum([
  "ELDERLY_CARE",
  "SOLO_LIVING",
  "ACTIVE_SESSION",
  "JOURNEY_WATCH",
  "POST_OP_RECOVERY",
]);
export type SentinelMode = z.infer<typeof SentinelModeSchema>;

export const IncidentStageSchema = z.enum([
  "STAGE_1_CONVERSATIONAL_WHATSAPP",
  "STAGE_2_GENTLE_DEVICE_CHIME",
  "STAGE_3_OBSERVER_SILENT_ALERT",
  "STAGE_4_HYPERLOCAL_DISPATCH",
]);
export type IncidentStage = z.infer<typeof IncidentStageSchema>;

export const IncidentStatusSchema = z.enum(["OPEN", "RESOLVED", "HANDED_OFF_SOS"]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const ResolutionSourceSchema = z.enum([
  "SCREEN_UNLOCK",
  "STEP_DELTA",
  "CHARGER_UNPLUG",
  "GHOST_SIGNAL",
  "WHATSAPP_RESPONSE",
  "ANCHOR_DISMISSAL",
  "OBSERVER_OVERRIDE",
  "SHADOW_SOS_HANDOFF",
  "CO_LIVING_PARTNER_CONFIRMED",
  "RESPONDER_CONFIRMED",
]);
export type ResolutionSource = z.infer<typeof ResolutionSourceSchema>;

export const SubscriptionTierSchema = z.enum(["TRIAL", "PRO", "SHIELD_PAUSED"]);
export type SubscriptionTier = z.infer<typeof SubscriptionTierSchema>;

export const BillingIntervalSchema = z.enum(["MONTHLY", "ANNUAL"]);
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;

export const AdminRoleSchema = z.enum(["SUPER_ADMIN", "SUPPORT_AGENT", "BILLING_OPS"]);
export type AdminRole = z.infer<typeof AdminRoleSchema>;

export const AuditActionSchema = z.enum(["VIEW", "QUERY", "MUTATION", "EXPORT", "SECURITY_VIOLATION"]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const SparshTypeSchema = z.enum([
  "MORNING_CHAI",
  "PRANAM_BLESSING",
  "MORNING_SUN",
  "MARIGOLD_FLOWER",
  "HEART_BLESSING",
]);
export type SparshType = z.infer<typeof SparshTypeSchema>;

export const GhostSignalTypeSchema = z.enum(["MEDIA_DEVICE_WAKE", "HOME_WIFI_REASSOCIATION"]);
export type GhostSignalType = z.infer<typeof GhostSignalTypeSchema>;

export const DossierAccessStateSchema = z.enum(["LOCKED", "RELEASED_EMERGENCY", "EXPIRED"]);
export type DossierAccessState = z.infer<typeof DossierAccessStateSchema>;

export const LoginChannelSchema = z.enum(["MOBILE", "WEB"]);
export type LoginChannel = z.infer<typeof LoginChannelSchema>;

export const BatteryWarningKindSchema = z.enum([
  "BEDTIME_LOW",
  "PRE_DAWN_BATTERY_EXHAUSTION_WARNING",
]);
export type BatteryWarningKind = z.infer<typeof BatteryWarningKindSchema>;

/** Derived Observer/dashboard well-being state (R15.1). Not a Prisma enum. */
export const WellBeingStateSchema = z.enum(["ALL_WELL", "SHIELD_PAUSED", "ESCALATING"]);
export type WellBeingState = z.infer<typeof WellBeingStateSchema>;

export const ChargerStateSchema = z.enum(["PLUGGED", "UNPLUGGED"]);
export type ChargerState = z.infer<typeof ChargerStateSchema>;
