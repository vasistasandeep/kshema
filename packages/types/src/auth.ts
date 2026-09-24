/**
 * @kshema/types — auth & identity DTOs (R1).
 *
 * `otp/verify` accepts ONLY `clientPublicKeyPem` — never a private key.
 * The private key is retained in the Secure_Enclave and is structurally
 * excluded from every request DTO (R1.8).
 */
import { z } from "zod";
import { IsoDateTime, NonEmptyString, PhoneNumber, PublicKeyPem, Timezone } from "./common.js";

export const OtpRequestSchema = z
  .object({
    phone: PhoneNumber,
  })
  .strict();
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpRequestResponseSchema = z
  .object({
    challengeId: NonEmptyString,
  })
  .strict();
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>;

/**
 * OTP verify request. Accepts only the client PUBLIC key (R1.8) — `.strict()`
 * rejects any unexpected field, so a private-key field cannot slip through.
 */
export const OtpVerifySchema = z
  .object({
    challengeId: NonEmptyString,
    code: z.string().trim().min(4).max(10),
    clientPublicKeyPem: PublicKeyPem,
    preferredName: NonEmptyString.optional(),
    timezone: Timezone,
    pushToken: NonEmptyString.optional(),
  })
  .strict();
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const AuthSessionSchema = z
  .object({
    userId: NonEmptyString,
    accessToken: NonEmptyString,
    refreshToken: NonEmptyString,
    expiresAt: IsoDateTime,
  })
  .strict();
export type AuthSession = z.infer<typeof AuthSessionSchema>;
