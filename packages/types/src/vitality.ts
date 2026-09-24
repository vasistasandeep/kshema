/**
 * @kshema/types — vitality, Sparsh, and Panchanga DTOs (R7, R22).
 *
 * These family-engagement surfaces carry no location trace and never drive
 * escalation (R22). Voice notes are bounded to <=10s (R7.4).
 */
import { z } from "zod";
import { SparshTypeSchema } from "./enums.js";
import { Id, IsoDateTime, NonEmptyString } from "./common.js";

export const VoiceNoteSchema = z
  .object({
    anchorId: Id,
    audio: NonEmptyString,
    durationSeconds: z.number().min(0).max(10),
  })
  .strict();
export type VoiceNote = z.infer<typeof VoiceNoteSchema>;

export const SparshSchema = z
  .object({
    circleId: Id,
    toUserId: Id,
    type: SparshTypeSchema,
  })
  .strict();
export type Sparsh = z.infer<typeof SparshSchema>;

export const SparshRhythmQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
  })
  .strict();
export type SparshRhythmQuery = z.infer<typeof SparshRhythmQuerySchema>;

/** Vitality Pulse card fields (R7.2) — preferred name + confirmation context. */
export const VitalityPulseSchema = z
  .object({
    anchorId: Id,
    preferredName: NonEmptyString,
    confirmedAt: IsoDateTime,
    stepContext: z.number().int().min(0).optional(),
    weatherContext: NonEmptyString.optional(),
  })
  .strict();
export type VitalityPulse = z.infer<typeof VitalityPulseSchema>;

export const PanchangaQuerySchema = z
  .object({
    locationKey: NonEmptyString.optional(),
    language: NonEmptyString.optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd")
      .optional(),
  })
  .strict();
export type PanchangaQuery = z.infer<typeof PanchangaQuerySchema>;

export const PanchangaCardSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sunrise: NonEmptyString,
    sunset: NonEmptyString,
    tithi: NonEmptyString,
    nakshatra: NonEmptyString,
    masa: NonEmptyString,
    festivals: z.array(NonEmptyString).default([]),
    proverb: NonEmptyString,
  })
  .strict();
export type PanchangaCard = z.infer<typeof PanchangaCardSchema>;
