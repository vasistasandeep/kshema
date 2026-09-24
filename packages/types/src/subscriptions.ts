/**
 * @kshema/types — subscription & billing DTOs (R20, R28.16, R28.17).
 */
import { z } from "zod";
import { BillingIntervalSchema, SubscriptionTierSchema } from "./enums.js";
import { Id, IsoDateTime, NonEmptyString } from "./common.js";

export const CheckoutSchema = z
  .object({
    interval: BillingIntervalSchema,
  })
  .strict();
export type Checkout = z.infer<typeof CheckoutSchema>;

export const CheckoutResponseSchema = z
  .object({
    checkoutUrl: NonEmptyString,
  })
  .strict();
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

export const SubscriptionSummarySchema = z
  .object({
    circleId: Id,
    tier: SubscriptionTierSchema,
    interval: BillingIntervalSchema.optional(),
    trialEndsAt: IsoDateTime,
    proSince: IsoDateTime.optional(),
  })
  .strict();
export type SubscriptionSummary = z.infer<typeof SubscriptionSummarySchema>;
