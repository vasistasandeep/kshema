/**
 * @kshema/types — Emergency Medical Dossier & responder-portal DTOs (R29, R33).
 *
 * The dossier PUT accepts ciphertext only; the server stores it blind (R33.2).
 * The responder triage payload STRUCTURALLY EXCLUDES location history,
 * financial data, and chat history (R29.7). `.strict()` guarantees no such
 * field can appear on the response DTO.
 */
import { z } from "zod";
import { Base64, Id, IsoDateTime, NonEmptyString, PhoneNumber } from "./common.js";

/** Envelope-encrypted dossier upsert — ciphertext only (R33.1, R33.2). */
export const UpsertMedicalDossierSchema = z
  .object({
    encryptedPayload: Base64,
    iv: Base64,
    authTag: Base64,
    encryptedEmergencyKey: Base64,
    bloodGroup: NonEmptyString.optional(),
    allergies: z.array(NonEmptyString).optional(),
    chronicConditions: z.array(NonEmptyString).optional(),
    criticalMedications: z.array(NonEmptyString).optional(),
    attendingDoctorName: NonEmptyString.optional(),
    attendingDoctorPhone: PhoneNumber.optional(),
    healthInsurancePolicy: NonEmptyString.optional(),
  })
  .strict();
export type UpsertMedicalDossier = z.infer<typeof UpsertMedicalDossierSchema>;

/** Decrypted-for-emergency dossier shown only at STAGE_4 (R33.3). */
export const EmergencyDossierViewSchema = z
  .object({
    bloodGroup: NonEmptyString.optional(),
    allergies: z.array(NonEmptyString).default([]),
    chronicConditions: z.array(NonEmptyString).default([]),
    criticalMedications: z.array(NonEmptyString).default([]),
    attendingDoctorName: NonEmptyString.optional(),
    attendingDoctorPhone: PhoneNumber.optional(),
    healthInsurancePolicy: NonEmptyString.optional(),
  })
  .strict();
export type EmergencyDossierView = z.infer<typeof EmergencyDossierViewSchema>;

/**
 * Read-only responder triage payload. Excludes location history, financial,
 * and chat data by construction (R29.7). No such field is declared here and
 * `.strict()` forbids it appearing.
 */
export const ResponderTriagePayloadSchema = z
  .object({
    preferredName: NonEmptyString,
    society: NonEmptyString.optional(),
    building: NonEmptyString.optional(),
    flat: NonEmptyString.optional(),
    doorAccessInstructions: NonEmptyString.optional(),
    smartLockBackupCodes: z.array(NonEmptyString).default([]),
    primaryObserverDialer: PhoneNumber.optional(),
    incidentStage: NonEmptyString,
    dossier: EmergencyDossierViewSchema.optional(),
  })
  .strict();
export type ResponderTriagePayload = z.infer<typeof ResponderTriagePayloadSchema>;

export const EmergencyTokenParamSchema = z
  .object({
    token: NonEmptyString,
  })
  .strict();
export type EmergencyTokenParam = z.infer<typeof EmergencyTokenParamSchema>;

export const ResponderConfirmSchema = z
  .object({
    responderName: NonEmptyString,
  })
  .strict();
export type ResponderConfirm = z.infer<typeof ResponderConfirmSchema>;

export const TokenConcludedSchema = z
  .object({
    concluded: z.literal(true),
    message: NonEmptyString,
  })
  .strict();
export type TokenConcluded = z.infer<typeof TokenConcludedSchema>;

/** Minimal emergency-token metadata (no raw token — hash stored server-side). */
export const EmergencyTokenInfoSchema = z
  .object({
    incidentId: Id,
    scope: z.literal("EMERGENCY_TRIAGE_READ"),
    expiresAt: IsoDateTime,
    invalidatedAt: IsoDateTime.optional(),
  })
  .strict();
export type EmergencyTokenInfo = z.infer<typeof EmergencyTokenInfoSchema>;
