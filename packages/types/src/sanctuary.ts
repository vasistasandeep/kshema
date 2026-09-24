/**
 * @kshema/types — Sanctuary Mode DTOs (R34).
 *
 * `resumesAt` must be within 14 days of `startsAt` (R34.1).
 */
import { z } from "zod";
import { Id, IsoDateTime, NonEmptyString } from "./common.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export const CreateSanctuarySchema = z
  .object({
    anchorId: Id,
    startsAt: IsoDateTime,
    resumesAt: IsoDateTime,
    reason: NonEmptyString.optional(),
  })
  .strict()
  .refine(
    (v) => {
      const start = Date.parse(v.startsAt);
      const resume = Date.parse(v.resumesAt);
      return resume > start && resume - start <= FOURTEEN_DAYS_MS;
    },
    { message: "resumesAt must be after startsAt and within 14 days (R34.1)" },
  );
export type CreateSanctuary = z.infer<typeof CreateSanctuarySchema>;

export const ActiveSanctuaryQuerySchema = z
  .object({
    anchorId: Id,
  })
  .strict();
export type ActiveSanctuaryQuery = z.infer<typeof ActiveSanctuaryQuerySchema>;

export const SanctuaryWindowSchema = z
  .object({
    id: Id,
    anchorId: Id,
    startsAt: IsoDateTime,
    resumesAt: IsoDateTime,
    reason: NonEmptyString.optional(),
    isActive: z.boolean(),
  })
  .strict();
export type SanctuaryWindow = z.infer<typeof SanctuaryWindowSchema>;
