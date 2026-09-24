/**
 * @kshema/types — incident lifecycle DTOs (R11, R13, R14).
 *
 * `trigger-sos` carries a one-shot decrypted location supplied by the Anchor
 * at SOS time only. This is NOT a continuous location trace (R5.5/R19.1
 * forbid persisted continuous traces); it is the Anchor's own point-in-time
 * SOS coordinate released deliberately for hyperlocal dispatch (R11.4-11.6).
 */
import { z } from "zod";
import {
  IncidentStageSchema,
  IncidentStatusSchema,
  ResolutionSourceSchema,
} from "./enums.js";
import { Id, IsoDateTime, NonEmptyString } from "./common.js";

export const ResolveIncidentSchema = z
  .object({
    source: ResolutionSourceSchema,
  })
  .strict();
export type ResolveIncident = z.infer<typeof ResolveIncidentSchema>;

/** Anchor-supplied point-in-time SOS location (not a persisted trace). */
export const SosLocationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().min(0).optional(),
    capturedAt: IsoDateTime,
  })
  .strict();
export type SosLocation = z.infer<typeof SosLocationSchema>;

export const TriggerSosSchema = z
  .object({
    decryptedLocation: SosLocationSchema.optional(),
  })
  .strict();
export type TriggerSos = z.infer<typeof TriggerSosSchema>;

export const IncidentSummarySchema = z
  .object({
    incidentId: Id,
    circleId: Id,
    anchorId: Id,
    stage: IncidentStageSchema,
    status: IncidentStatusSchema,
    simulated: z.boolean(),
    batteryDepletionLikely: z.boolean(),
    resolutionSource: ResolutionSourceSchema.optional(),
    openedAt: IsoDateTime,
    resolvedAt: IsoDateTime.optional(),
  })
  .strict();
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;

export const IncidentAuditEntrySchema = z
  .object({
    stage: IncidentStageSchema.optional(),
    at: IsoDateTime,
    cause: NonEmptyString,
  })
  .strict();
export type IncidentAuditEntry = z.infer<typeof IncidentAuditEntrySchema>;
