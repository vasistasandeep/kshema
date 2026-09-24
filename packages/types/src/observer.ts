/**
 * @kshema/types — Observer dashboard DTOs (R15).
 *
 * The dashboard excludes any continuous location trace (R15.5, R19.1).
 * Only derived well-being state, preferred name, and last confirmation time
 * are exposed. `.strict()` forbids any location field.
 */
import { z } from "zod";
import { IncidentStageSchema, WellBeingStateSchema } from "./enums.js";
import { Id, IsoDateTime, NonEmptyString } from "./common.js";

export const AnchorWellBeingSchema = z
  .object({
    anchorId: Id,
    preferredName: NonEmptyString,
    state: WellBeingStateSchema,
    escalationStage: IncidentStageSchema.optional(),
    lastConfirmationAt: IsoDateTime.optional(),
  })
  .strict();
export type AnchorWellBeing = z.infer<typeof AnchorWellBeingSchema>;

export const ObserverDashboardSchema = z
  .object({
    anchors: z.array(AnchorWellBeingSchema).default([]),
  })
  .strict();
export type ObserverDashboard = z.infer<typeof ObserverDashboardSchema>;
