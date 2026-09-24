/**
 * @kshema/types — admin console DTOs (R21).
 *
 * Phone numbers surfaced to admin views are masked to the last 4 digits
 * except during an active Stage-4 triage (R21.8). The admin surface exposes
 * NO black-box decrypt path and NO live location/audio field (R21.6, R21.7),
 * so no such field is declared here and `.strict()` forbids it.
 */
import { z } from "zod";
import {
  AdminRoleSchema,
  IncidentStageSchema,
  IncidentStatusSchema,
  SubscriptionTierSchema,
} from "./enums.js";
import { Id, IsoDateTime, NonEmptyString } from "./common.js";

/** Phone masked to last 4 digits, e.g. "••••1234" (R21.8). */
export const MaskedPhone = z.string().trim().min(1);

export const RetryDispatchSchema = z
  .object({
    justification: NonEmptyString.optional(),
  })
  .strict();
export type RetryDispatch = z.infer<typeof RetryDispatchSchema>;

export const TrialExtensionSchema = z
  .object({
    additionalDays: z.number().int().min(1).max(60),
    justification: NonEmptyString,
  })
  .strict();
export type TrialExtension = z.infer<typeof TrialExtensionSchema>;

export const PurgeRequestSchema = z
  .object({
    justification: NonEmptyString,
  })
  .strict();
export type PurgeRequest = z.infer<typeof PurgeRequestSchema>;

export const WakefulnessTestSchema = z
  .object({
    justification: NonEmptyString.optional(),
  })
  .strict();
export type WakefulnessTest = z.infer<typeof WakefulnessTestSchema>;

export const FleetPulseSchema = z
  .object({
    activeCircles: z.number().int().min(0),
    telemetryAtRisk: z.number().int().min(0),
    openIncidents: z.number().int().min(0),
  })
  .strict();
export type FleetPulse = z.infer<typeof FleetPulseSchema>;

export const CarrierHealthSchema = z
  .object({
    gateway: NonEmptyString,
    errorRate: z.number().min(0).max(1),
    deliveryLatencyMs: z.number().int().min(0).optional(),
    windowStart: IsoDateTime,
  })
  .strict();
export type CarrierHealth = z.infer<typeof CarrierHealthSchema>;

export const LiveIncidentSchema = z
  .object({
    incidentId: Id,
    stage: IncidentStageSchema,
    status: IncidentStatusSchema,
    maskedAnchorPhone: MaskedPhone,
    openedAt: IsoDateTime,
  })
  .strict();
export type LiveIncident = z.infer<typeof LiveIncidentSchema>;

export const AdminSubscriptionRowSchema = z
  .object({
    circleId: Id,
    tier: SubscriptionTierSchema,
    trialEndsAt: IsoDateTime,
  })
  .strict();
export type AdminSubscriptionRow = z.infer<typeof AdminSubscriptionRowSchema>;

export const AdminIdentitySchema = z
  .object({
    adminUserId: Id,
    role: AdminRoleSchema,
    mfaEnrolled: z.boolean(),
  })
  .strict();
export type AdminIdentity = z.infer<typeof AdminIdentitySchema>;

/**
 * Acknowledgement for a manual carrier-fallback retry dispatch (R21.12). No
 * black-box or location payload is ever surfaced — only the dispatch outcome.
 */
export const RetryDispatchAckSchema = z
  .object({
    incidentId: Id,
    dispatched: z.literal(true),
  })
  .strict();
export type RetryDispatchAck = z.infer<typeof RetryDispatchAckSchema>;

/**
 * Result of a trial extension (R21.19). Reports the tier BEFORE and AFTER so
 * the console can show the SHIELD_PAUSED -> TRIAL restoration explicitly, along
 * with the new trial expiry.
 */
export const TrialExtensionResultSchema = z
  .object({
    circleId: Id,
    previousTier: SubscriptionTierSchema,
    tier: SubscriptionTierSchema,
    trialEndsAt: IsoDateTime,
  })
  .strict();
export type TrialExtensionResult = z.infer<typeof TrialExtensionResultSchema>;

/**
 * Acknowledgement for a scheduled cryptographic purge request (R21.21). The
 * personal data is deleted only after the 30-day grace window elapses, so the
 * console shows the `purgeAfter` timestamp rather than an immediate deletion.
 */
export const PurgeRequestAckSchema = z
  .object({
    userId: Id,
    scheduled: z.literal(true),
    /** When the cryptographic purge becomes eligible (requestedAt + 30 days). */
    purgeAfter: IsoDateTime,
  })
  .strict();
export type PurgeRequestAck = z.infer<typeof PurgeRequestAckSchema>;

/** Acknowledgement for a silent device wakefulness-test push ping (R21.18). */
export const WakefulnessTestAckSchema = z
  .object({
    deviceId: Id,
    pinged: z.literal(true),
  })
  .strict();
export type WakefulnessTestAck = z.infer<typeof WakefulnessTestAckSchema>;

/**
 * A failed subscription/payment webhook awaiting admin re-drive (R21.20). The
 * raw payload is base64-encoded so the console can inspect, edit, and re-drive
 * it. No decrypted or location data is carried.
 */
export const WebhookErrorItemSchema = z
  .object({
    provider: z.enum(["apple", "google", "upi"]),
    rawBodyBase64: NonEmptyString,
    reason: NonEmptyString,
    at: IsoDateTime,
  })
  .strict();
export type WebhookErrorItem = z.infer<typeof WebhookErrorItemSchema>;
